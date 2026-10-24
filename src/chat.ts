import { encodeSse, ssePadding } from "./sse";
import { titleFromMessage, type ConversationStore } from "./store";
import { SYSTEM_PROMPT, type LlmProvider } from "./llm";
import { applyStreamEvent, emptyTrace, hasVisibleStream } from "./trace";
import type { LlmMessage, LlmStreamEvent, MessageTrace } from "./types";

const MAX_MESSAGE_LENGTH = 20_000;

const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
};

function isAbort(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  return error instanceof Error && error.name === "AbortError";
}

function eventName(event: LlmStreamEvent): string {
  return event.type === "text" ? "delta" : event.type;
}

function eventData(event: LlmStreamEvent): unknown {
  switch (event.type) {
    case "start":
      return { role: event.role };
    case "reasoning":
    case "text":
      return { text: event.text };
    case "tool_call": {
      const data: { index: number; id?: string; name?: string; arguments?: string } = {
        index: event.index,
      };
      if (event.id) data.id = event.id;
      if (event.name) data.name = event.name;
      if (event.arguments) data.arguments = event.arguments;
      return data;
    }
    case "tool_result":
      return { id: event.id, name: event.name, content: event.content };
    case "end":
      return { finishReason: event.finishReason };
  }
}

export async function streamChatTurn(options: {
  store: ConversationStore;
  provider: LlmProvider;
  message: string;
  conversationId?: string;
  signal?: AbortSignal;
}): Promise<Response> {
  const message = options.message.trim();
  if (!message) {
    return Response.json({ error: "Message is required" }, { status: 400 });
  }
  if (message.length > MAX_MESSAGE_LENGTH) {
    return Response.json({ error: "Message is too long" }, { status: 400 });
  }

  const conversationId = options.conversationId?.trim() || undefined;
  const conversation = conversationId
    ? (await options.store.getConversation(conversationId))?.conversation
    : await options.store.createConversation(titleFromMessage(message));
  if (!conversation) return Response.json({ error: "Conversation not found" }, { status: 404 });

  const user = await options.store.addMessage(conversation.id, "user", message);
  const stored = await options.store.getConversation(conversation.id);
  const history: LlmMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    ...(stored?.messages ?? [])
      .filter((item) => item.content.length > 0)
      .map((item) => ({ role: item.role, content: item.content })),
  ];

  const { store, provider, signal } = options;
  const conversationSnapshot = conversation;
  let partial = "";
  let trace = emptyTrace();
  let assistantId: string | null = null;
  let saved = "";
  let persistQueue = Promise.resolve();

  const persist = (text: string, current: MessageTrace) => {
    const encoded = JSON.stringify({ text, trace: current });
    persistQueue = persistQueue.then(async () => {
      if (encoded === saved) return;
      if (!hasVisibleStream(current, text)) return;
      if (!assistantId) {
        const created = await store.addMessage(conversationSnapshot.id, "assistant", text, current);
        assistantId = created.id;
      } else {
        await store.updateMessage(assistantId, text, current);
      }
      saved = encoded;
    });
    return persistQueue;
  };

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const enqueue = (event: string, data: unknown) => {
        if (closed || signal?.aborted) return;
        try {
          controller.enqueue(encodeSse(event, data));
        } catch {
          closed = true;
        }
      };
      const close = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          closed = true;
        }
      };

      const publish = async (next: MessageTrace, event: LlmStreamEvent) => {
        trace = next;
        partial = next.text;
        await persist(partial, trace);
        if (signal?.aborted) return;
        enqueue(eventName(event), eventData(event));
      };

      try {
        controller.enqueue(ssePadding());
        enqueue("meta", {
          conversationId: conversationSnapshot.id,
          title: conversationSnapshot.title,
          userMessageId: user.id,
        });

        let sawStart = false;
        let sawEnd = false;
        for await (const event of provider.stream(history, signal)) {
          if (signal?.aborted) break;
          if (!sawStart && event.type !== "start") {
            sawStart = true;
            await publish(applyStreamEvent(trace, { type: "start", role: "assistant" }), {
              type: "start",
              role: "assistant",
            });
            if (signal?.aborted) break;
          }
          if (event.type === "start") sawStart = true;
          if (event.type === "end") sawEnd = true;
          await publish(applyStreamEvent(trace, event), event);
          if (signal?.aborted) break;
        }
        if (!signal?.aborted && sawStart && !sawEnd) {
          await publish(applyStreamEvent(trace, { type: "end", finishReason: "stop" }), {
            type: "end",
            finishReason: "stop",
          });
        }
        await persist(partial, trace);
        if (!signal?.aborted) {
          enqueue("done", {
            conversationId: conversationSnapshot.id,
            assistantMessageId: assistantId,
          });
        }
      } catch (error) {
        await persist(partial, trace);
        if (!isAbort(error, signal)) {
          const text = error instanceof Error ? error.message : "The model request failed";
          enqueue("error", { message: text });
        }
      } finally {
        await persist(partial, trace);
        close();
      }
    },
    async cancel() {
      await persist(partial, trace);
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}
