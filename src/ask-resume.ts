import type { LlmProvider } from "./llm";
import type { ConversationStore } from "./store";
import { applyStreamEvent, emptyTrace } from "./trace";
import { buildModelInput } from "./turn";
import { ASK_USER_TOOL, readAskUser } from "./tools/ask-user";
import { runTool, type ToolRegistry } from "./tools/registry";
import type { ToolDefinition } from "./tools/types";
import type { LlmMessage, LlmToolCall, MessageTrace, StoredToolCall } from "./types";

const MAX_ROUNDS = 4;

/**
 * Continue a paused ask_user turn from the stored question. The tool row is
 * already claimed, so a second instance cannot continue it too.
 */
export async function resumeStoredAsk(options: {
  store: ConversationStore;
  provider: LlmProvider;
  tools: ToolRegistry;
  tool: StoredToolCall;
  answer: string;
}): Promise<void> {
  const loaded = await options.store.getConversation(options.tool.conversationId);
  if (!loaded) throw new Error("Conversation not found");
  const message = loaded.messages.find((item) => item.id === options.tool.messageId);
  if (!message) throw new Error("Question message not found");

  let trace = applyStreamEvent(message.trace ?? emptyTrace(), {
    type: "tool_result",
    id: options.tool.id,
    name: ASK_USER_TOOL,
    content: options.answer,
  });
  await options.store.updateMessage(message.id, trace.text, trace);

  const prepared = await buildModelInput({
    store: options.store,
    conversationId: options.tool.conversationId,
    agentId: loaded.conversation.agentId,
  });
  const system = prepared?.messages.find((item) => item.role === "system")?.content ?? "";
  const history: LlmMessage[] = [{ role: "system", content: system }];
  for (const item of loaded.messages) {
    if (item.id === message.id) {
      history.push({
        role: "assistant",
        content: item.content,
        tool_calls: [toolCall(options.tool.id, ASK_USER_TOOL, options.tool.arguments)],
      });
      history.push({ role: "tool", tool_call_id: options.tool.id, content: options.answer });
      break;
    }
    if (item.role === "user") history.push({ role: "user", content: item.content });
    else if (item.content.trim()) history.push({ role: "assistant", content: item.content });
  }

  const promoted = new Set<string>();
  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const exposed = options.tools.exposed({ promoted });
    const signal = new AbortController().signal as AbortSignal & {
      tools?: readonly ToolDefinition[];
    };
    signal.tools = exposed;
    for await (const event of options.provider.stream(history, signal)) {
      trace = applyStreamEvent(trace, event);
      await options.store.updateMessage(message.id, trace.text, trace);
    }
    const pending = trace.tools.filter((tool) => tool.name && tool.result == null);
    if (pending.length === 0) break;
    const roundText = textSince(history, trace.text);
    history.push({
      role: "assistant",
      content: roundText,
      tool_calls: pending.map((tool) => toolCall(tool.id, tool.name, tool.arguments || "{}")),
    });
    let askedAgain = false;
    for (const call of pending) {
      if (!call.id) call.id = `call_${crypto.randomUUID()}`;
      if (call.name === ASK_USER_TOOL) {
        const parsed = readAskUser(call.arguments);
        if (!parsed) {
          trace = await recordResult(options.store, message.id, trace, {
            id: call.id,
            name: call.name,
            arguments: call.arguments,
            conversationId: options.tool.conversationId,
            status: "error",
            output: "ask_user requires a question and options.",
          });
          history.push({
            role: "tool",
            tool_call_id: call.id,
            content: "ask_user requires a question and options.",
          });
          continue;
        }
        await options.store.saveToolCall({
          id: call.id,
          conversationId: options.tool.conversationId,
          messageId: message.id,
          name: call.name,
          arguments: JSON.stringify(parsed),
          status: "ask",
          output: null,
        });
        askedAgain = true;
        continue;
      }
      const tool = options.tools.get(call.name);
      const result = tool
        ? await runTool(tool, parseObject(call.arguments), {
            promote: (names) => names.forEach((name) => promoted.add(name)),
          })
        : { content: `Unknown tool "${call.name}".`, isError: true as const };
      trace = await recordResult(options.store, message.id, trace, {
        id: call.id,
        name: call.name,
        arguments: call.arguments,
        conversationId: options.tool.conversationId,
        status: result.isError ? "error" : "done",
        output: result.content,
      });
      history.push({ role: "tool", tool_call_id: call.id, content: result.content });
    }
    if (askedAgain) return;
  }
  if (!trace.ended) {
    trace = applyStreamEvent(trace, { type: "end", finishReason: "stop" });
    await options.store.updateMessage(message.id, trace.text, trace);
  }
}

/** Write the settled tool result onto the assistant message that asked. */
export async function noteStoredAsk(
  store: ConversationStore,
  tool: StoredToolCall,
  output: string,
): Promise<void> {
  const loaded = await store.getConversation(tool.conversationId);
  const message = loaded?.messages.find((item) => item.id === tool.messageId);
  if (!message) return;
  const trace = applyStreamEvent(message.trace ?? emptyTrace(), {
    type: "tool_result",
    id: tool.id,
    name: tool.name,
    content: output,
  });
  await store.updateMessage(message.id, trace.text || message.content, trace);
}

function toolCall(id: string, name: string, args: string): LlmToolCall {
  return { id, type: "function", function: { name, arguments: args || "{}" } };
}

function parseObject(raw: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw || "{}") as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return value as Record<string, unknown>;
  } catch {
    return {};
  }
}

function textSince(history: LlmMessage[], full: string): string {
  const previous = [...history].reverse().find((message) => message.role === "assistant");
  const prefix = previous?.content ?? "";
  return full.startsWith(prefix) ? full.slice(prefix.length) : full;
}

async function recordResult(
  store: ConversationStore,
  messageId: string,
  trace: MessageTrace,
  call: {
    id: string;
    name: string;
    arguments: string;
    conversationId: string;
    status: StoredToolCall["status"];
    output: string;
  },
): Promise<MessageTrace> {
  await store.saveToolCall({
    id: call.id,
    conversationId: call.conversationId,
    messageId,
    name: call.name,
    arguments: call.arguments,
    status: call.status,
    output: call.output,
  });
  const next = applyStreamEvent(trace, {
    type: "tool_result",
    id: call.id,
    name: call.name,
    content: call.output,
  });
  await store.updateMessage(messageId, next.text, next);
  return next;
}
