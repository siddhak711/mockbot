import { encodeSse, ssePadding } from "./sse";
import { titleFromMessage, type ConversationStore } from "./store";
import { SYSTEM_PROMPT, type LlmProvider, type ProviderEvent } from "./llm";
import { requiresApproval, type ApprovalGate } from "./tools/approval";
import { runTool, type ToolRegistry } from "./tools/registry";
import { describeTool, previewText } from "./tools/display";
import type { ToolContext } from "./tools/types";
import type { LlmMessage, LlmToolCall, Message, ToolCallStatus } from "./types";

const MAX_MESSAGE_LENGTH = 20_000;
const MAX_ROUNDS = 8;

const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
};

type LiveCall = {
  id: string;
  name: string;
  arguments: string;
  status: ToolCallStatus;
  output: string | null;
  started: boolean;
};

function isAbort(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  return error instanceof Error && error.name === "AbortError";
}

function toLlmHistory(messages: Message[]): LlmMessage[] {
  const history: LlmMessage[] = [{ role: "system", content: SYSTEM_PROMPT }];
  for (const message of messages) {
    if (message.role === "user") {
      history.push({ role: "user", content: message.content });
      continue;
    }
    const tools = message.tools ?? [];
    if (tools.length === 0) {
      history.push({ role: "assistant", content: message.content });
      continue;
    }
    const trace = tools
      .map((tool) => {
        const output = tool.output ? previewText(tool.output) : tool.status;
        return `${tool.name} (${tool.status}): ${output}`;
      })
      .join("\n");
    const content = [message.content.trim(), `Previous tool activity:\n${trace}`]
      .filter(Boolean)
      .join("\n\n");
    history.push({ role: "assistant", content });
  }
  return history;
}

function denialText(reason: "user" | "timeout"): string {
  if (reason === "timeout") {
    return "Approval timed out before the user responded, so the action was not run. Do not retry it unless they ask.";
  }
  return "The user denied this action. Do not retry it unless they ask.";
}

export async function streamChatTurn(options: {
  store: ConversationStore;
  provider: LlmProvider;
  tools: ToolRegistry;
  approvals: ApprovalGate;
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
  const history = toLlmHistory(stored?.messages ?? []);

  const { store, provider, tools, approvals, signal } = options;
  const conversationSnapshot = conversation;
  const promoted = new Set<string>();
  const toolContext: ToolContext = {
    signal,
    promote(names) {
      for (const name of names) promoted.add(name);
    },
  };

  let partial = "";
  let assistantId: string | null = null;
  let saved = "";
  let persistQueue = Promise.resolve();
  const liveCalls: LiveCall[] = [];

  const persist = (text: string) => {
    persistQueue = persistQueue.then(async () => {
      if (text === saved) return;
      if (!assistantId) return;
      await store.updateMessageContent(assistantId, text);
      saved = text;
    });
    return persistQueue;
  };

  const ensureAssistant = async (): Promise<string> => {
    if (assistantId) return assistantId;
    const created = await store.addMessage(conversationSnapshot.id, "assistant", "");
    assistantId = created.id;
    saved = "";
    return created.id;
  };

  const saveCall = async (call: LiveCall) => {
    const messageId = await ensureAssistant();
    await store.saveToolCall({
      id: call.id,
      conversationId: conversationSnapshot.id,
      messageId,
      name: call.name,
      arguments: call.arguments,
      status: call.status,
      output: call.output,
    });
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

      const stopOpenCalls = async () => {
        for (const call of liveCalls) {
          if (call.status !== "running" && call.status !== "approval") continue;
          call.status = "error";
          call.output = "Stopped before the tool finished.";
          await saveCall(call);
        }
      };

      try {
        controller.enqueue(ssePadding());
        enqueue("meta", {
          conversationId: conversationSnapshot.id,
          title: conversationSnapshot.title,
          userMessageId: user.id,
        });

        for (let round = 0; round < MAX_ROUNDS; round += 1) {
          if (signal?.aborted) break;
          const exposed = tools.exposed({ promoted });
          const turnCalls: LiveCall[] = [];
          let roundText = "";
          const applyProviderEvent = async (event: ProviderEvent): Promise<void> => {
            if (event.type === "text") {
              if (!event.text) return;
              partial += event.text;
              roundText += event.text;
              const messageId = await ensureAssistant();
              enqueue("delta", { text: event.text, assistantMessageId: messageId });
              await persist(partial);
              return;
            }
            let call = turnCalls.find((item) => item.id === event.id);
            if (!call) {
              call = {
                id: event.id,
                name: event.name ?? "",
                arguments: "",
                status: "running",
                output: null,
                started: false,
              };
              turnCalls.push(call);
              liveCalls.push(call);
            }
            if (event.name) call.name = event.name;
            if (event.argumentsDelta) call.arguments += event.argumentsDelta;
            if (!call.started && call.name) {
              call.started = true;
              const messageId = await ensureAssistant();
              await saveCall(call);
              enqueue("tool_start", {
                id: call.id,
                name: call.name,
                assistantMessageId: messageId,
              });
            }
            if (call.started && event.argumentsDelta) {
              await saveCall(call);
              enqueue("tool_args", { id: call.id, arguments: call.arguments });
            }
          };
          for await (const event of provider.stream(history, { tools: exposed, signal })) {
            if (signal?.aborted) break;
            await applyProviderEvent(event);
          }
          if (signal?.aborted) break;
          if (turnCalls.length === 0) break;

          history.push({
            role: "assistant",
            content: roundText,
            tool_calls: turnCalls.map(toLlmToolCall),
          });

          for (const call of turnCalls) {
            if (signal?.aborted) break;
            const output = await executeCall(call);
            if (output === null) break;
            history.push({ role: "tool", tool_call_id: call.id, content: output });
          }
          if (signal?.aborted) break;
        }

        await persist(partial);
        if (signal?.aborted) {
          await stopOpenCalls();
        } else {
          enqueue("done", {
            conversationId: conversationSnapshot.id,
            assistantMessageId: assistantId,
          });
        }
      } catch (error) {
        await persist(partial);
        if (isAbort(error, signal)) {
          await stopOpenCalls();
        } else {
          await stopOpenCalls();
          const text = error instanceof Error ? error.message : "The model request failed";
          enqueue("error", { message: text });
        }
      } finally {
        await persist(partial);
        if (assistantId && partial === "" && liveCalls.length === 0) {
          await store.deleteMessage(assistantId);
          assistantId = null;
        }
        close();
      }

      async function executeCall(call: LiveCall): Promise<string | null> {
        const parsed = parseArguments(call.arguments);
        if (!parsed.ok) {
          return finish(call, "error", parsed.error);
        }
        const tool = tools.get(call.name);
        if (!tool) {
          return finish(
            call,
            "error",
            `Unknown tool "${call.name}". Call tool_search to find a tool.`,
          );
        }
        const prepared = tool.prepare ? tool.prepare(parsed.args) : { args: parsed.args };
        if ("error" in prepared) return finish(call, "error", prepared.error);
        if (requiresApproval(tool, prepared.args)) {
          call.status = "approval";
          await saveCall(call);
          const described = describeTool(call.name, JSON.stringify(prepared.args));
          enqueue("approval_required", {
            id: call.id,
            name: call.name,
            arguments: JSON.stringify(prepared.args),
            summary: described.summary,
            assistantMessageId: assistantId,
          });
          const outcome = await approvals.wait(call.id, signal);
          if (signal?.aborted || outcome.reason === "stopped") {
            call.status = "error";
            call.output = "Stopped before the tool ran.";
            await saveCall(call);
            return null;
          }
          if (outcome.decision !== "approve") {
            return finish(
              call,
              "denied",
              denialText(outcome.reason === "timeout" ? "timeout" : "user"),
            );
          }
          call.status = "running";
          await saveCall(call);
        }
        const result = await runTool(tool, prepared.args, toolContext);
        return finish(call, result.isError ? "error" : "done", result.content);
      }

      function finish(call: LiveCall, status: ToolCallStatus, output: string): Promise<string> {
        call.status = status;
        call.output = output;
        const messageId = assistantId;
        enqueue("tool_result", {
          id: call.id,
          name: call.name,
          status,
          output,
          assistantMessageId: messageId,
        });
        return saveCall(call).then(() => output);
      }
    },
    async cancel() {
      await persist(partial);
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}

function parseArguments(
  raw: string,
): { ok: true; args: Record<string, unknown> } | { ok: false; error: string } {
  const text = raw.trim() ? raw : "{}";
  try {
    const value = JSON.parse(text) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { ok: false, error: "Tool arguments must be a JSON object." };
    }
    return { ok: true, args: value as Record<string, unknown> };
  } catch {
    return { ok: false, error: "Tool arguments were not valid JSON." };
  }
}

function toLlmToolCall(call: LiveCall): LlmToolCall {
  return {
    id: call.id,
    type: "function",
    function: { name: call.name, arguments: call.arguments || "{}" },
  };
}
