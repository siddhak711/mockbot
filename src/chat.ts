import { encodeSse, ssePadding } from "./sse";
import { titleFromMessage, type ConversationStore } from "./store";
import { SYSTEM_PROMPT, type LlmProvider } from "./llm";
import type { LlmMessage } from "./types";

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
    ...(stored?.messages ?? []).map((item) => ({ role: item.role, content: item.content })),
  ];

  const { store, provider, signal } = options;
  const conversationSnapshot = conversation;
  let partial = "";
  let assistantId: string | null = null;
  let saved = "";
  let persistQueue = Promise.resolve();

  const persist = (text: string) => {
    persistQueue = persistQueue.then(async () => {
      if (!text || text === saved) return;
      if (!assistantId) {
        const created = await store.addMessage(conversationSnapshot.id, "assistant", text);
        assistantId = created.id;
      } else {
        await store.updateMessageContent(assistantId, text);
      }
      saved = text;
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

      try {
        controller.enqueue(ssePadding());
        enqueue("meta", {
          conversationId: conversationSnapshot.id,
          title: conversationSnapshot.title,
          userMessageId: user.id,
        });

        for await (const delta of provider.stream(history, signal)) {
          if (signal?.aborted) break;
          partial += delta;
          enqueue("delta", { text: delta });
          await persist(partial);
        }
        await persist(partial);
        if (!signal?.aborted) {
          enqueue("done", {
            conversationId: conversationSnapshot.id,
            assistantMessageId: assistantId,
          });
        }
      } catch (error) {
        await persist(partial);
        if (!isAbort(error, signal)) {
          const text = error instanceof Error ? error.message : "The model request failed";
          enqueue("error", { message: text });
        }
      } finally {
        await persist(partial);
        close();
      }
    },
    async cancel() {
      await persist(partial);
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}
