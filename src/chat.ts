import { DEFAULT_AGENT_ID } from "./agent";
import type { LlmProvider } from "./llm";
import { findSecrets } from "./memory/scrub";
import { encodeSse, ssePadding } from "./sse";
import { titleFromMessage, type ConversationStore } from "./store";
import { executeRegisteredTool, runToolLoop } from "./tools/loop";
import type { MemoryToolDeps, ToolDefinition } from "./tools/types";
import { buildModelInput } from "./turn";

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
  agentId?: string;
  signal?: AbortSignal;
  contextTokens?: number;
}): Promise<Response> {
  const message = options.message.trim();
  if (!message) {
    return Response.json({ error: "Message is required" }, { status: 400 });
  }
  if (message.length > MAX_MESSAGE_LENGTH) {
    return Response.json({ error: "Message is too long" }, { status: 400 });
  }

  const agentId = options.agentId ?? DEFAULT_AGENT_ID;
  const conversationId = options.conversationId?.trim() || undefined;
  const conversation = conversationId
    ? (await options.store.getConversation(conversationId, agentId))?.conversation
    : await options.store.createConversation(titleFromMessage(message), agentId);
  if (!conversation) return Response.json({ error: "Conversation not found" }, { status: 404 });

  const user = await options.store.addMessage(conversation.id, "user", message, agentId);
  const prepared = await buildModelInput({
    store: options.store,
    conversationId: conversation.id,
    agentId,
    contextTokens: options.contextTokens,
  });
  if (!prepared) return Response.json({ error: "Conversation not found" }, { status: 404 });

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
        const created = await store.addMessage(conversationSnapshot.id, "assistant", text, agentId);
        assistantId = created.id;
      } else {
        await store.updateMessageContent(assistantId, text, agentId);
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

        const result = await runToolLoop({
          provider,
          messages: prepared.messages,
          tools: prepared.tools,
          signal,
          onText: async (chunk) => {
            partial += chunk;
            enqueue("delta", { text: chunk });
            await persist(partial);
          },
          onTool: (call, phase) => {
            enqueue("tool", toolActivity(call, phase));
          },
          execute: async (call) => {
            const executed = await executeRegisteredTool(prepared.tools, call, signal);
            rememberToolOutput(prepared.deps, prepared.tools, call.name, executed.output);
            return executed;
          },
        });

        if (!signal?.aborted && !partial && result.toolCalls > 0) {
          const extra = result.capped
            ? "I stopped because the tool step limit was reached."
            : "Done.";
          partial = extra;
          enqueue("delta", { text: extra });
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

function rememberToolOutput(
  deps: MemoryToolDeps,
  tools: readonly ToolDefinition[],
  name: string,
  output: string,
): void {
  if (!tools.some((tool) => tool.name === name)) return;
  if (name.startsWith("memory_")) return;
  deps.toolOutputs.push(output);
}

function activityTitle(
  name: string,
  phase: "running" | "done",
  isError: boolean,
  blockedWrite: boolean,
): string {
  if (blockedWrite) return "Memory write blocked";
  const label =
    name === "memory_search"
      ? "Searching memory"
      : name === "memory_delete"
        ? "Forgetting a memory"
        : name === "memory_update"
          ? "Updating a memory"
          : name === "memory_write"
            ? "Saving a memory"
            : name;
  if (phase === "running" || !isError) return label;
  if (name === "memory_delete") return "Could not forget that memory";
  if (name === "memory_search") return "Memory search failed";
  if (name === "memory_update") return "Could not update that memory";
  if (name === "memory_write") return "Could not save that memory";
  return `${name} failed`;
}

export function toolActivity(
  call: { id: string; name: string; output: string; isError: boolean; blocked?: "secret" },
  phase: "running" | "done",
): {
  id: string;
  title: string;
  detail: string;
  state: "running" | "done";
  kind: "search" | "draft";
} {
  const secret = phase === "done" && findSecrets(call.output).length > 0;
  const blockedWrite = phase === "done" && call.blocked === "secret";
  const title = activityTitle(call.name, phase, call.isError, blockedWrite);
  const detail =
    phase === "running"
      ? "Running"
      : blockedWrite
        ? "Blocked. A secret was not stored."
        : secret
          ? "Finished. The result was not shown."
          : call.output.slice(0, 240);
  return {
    id: call.id,
    title,
    detail,
    state: phase === "running" ? "running" : "done",
    kind: call.name === "memory_search" ? "search" : "draft",
  };
}
