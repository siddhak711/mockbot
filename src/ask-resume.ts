import type { LlmProvider } from "./llm";
import type { ConversationStore } from "./store";
import { applyStreamEvent, emptyTrace } from "./trace";
import { buildModelInput } from "./turn";
import { ASK_USER_TOOL, readAskUser } from "./tools/ask-user";
import { requiresApproval } from "./tools/approval";
import { runTool, type ToolRegistry } from "./tools/registry";
import type { ToolDefinition } from "./tools/types";
import type {
  LlmMessage,
  LlmStreamEvent,
  LlmToolCall,
  MessageTrace,
  StoredToolCall,
} from "./types";

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
    // A new model round reuses tool index 0 and may reuse a call id. Shift the
    // index so it does not merge into the stored ask, and replace a colliding id
    // so the follow-up row does not overwrite that ask.
    const indexOffset = trace.tools.reduce((max, tool) => Math.max(max, tool.index), -1) + 1;
    const takenIds = new Set(trace.tools.map((tool) => tool.id).filter(Boolean));
    const idsByIndex = new Map<number, string>();
    for await (const event of options.provider.stream(history, signal)) {
      trace = applyStreamEvent(trace, shiftToolCall(event, indexOffset, takenIds, idsByIndex));
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
    let pause = false;
    for (const call of pending) {
      if (!call.id) call.id = `call_${crypto.randomUUID()}`;
      const settled = await settleFollowUp({
        store: options.store,
        tools: options.tools,
        conversationId: options.tool.conversationId,
        messageId: message.id,
        trace,
        call,
        promoted,
      });
      trace = settled.trace;
      if (settled.pause) {
        pause = true;
        break;
      }
      history.push({ role: "tool", tool_call_id: call.id, content: settled.output });
    }
    if (pause) return;
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

function shiftToolCall(
  event: LlmStreamEvent,
  indexOffset: number,
  takenIds: Set<string>,
  idsByIndex: Map<number, string>,
): LlmStreamEvent {
  if (event.type !== "tool_call") return event;
  const index = event.index + indexOffset;
  const assigned = idsByIndex.get(index);
  let id = assigned ?? event.id;
  if (!assigned && id && takenIds.has(id)) id = `call_${crypto.randomUUID()}`;
  if (id) {
    idsByIndex.set(index, id);
    takenIds.add(id);
  }
  return { ...event, index, ...(id ? { id } : {}) };
}

function toolCall(id: string, name: string, args: string): LlmToolCall {
  return { id, type: "function", function: { name, arguments: args || "{}" } };
}

type FollowUpCall = {
  id: string;
  name: string;
  arguments: string;
};

/**
 * Prepare one follow-up call the way the live chat turn does. Approval-required
 * tools are stored and left for the approvals flow. Anything that cannot be
 * gated is recorded as an error and is not run.
 */
async function settleFollowUp(options: {
  store: ConversationStore;
  tools: ToolRegistry;
  conversationId: string;
  messageId: string;
  trace: MessageTrace;
  call: FollowUpCall;
  promoted: Set<string>;
}): Promise<{ trace: MessageTrace; pause: boolean; output: string }> {
  const refuse = async (output: string) => {
    const trace = await recordResult(options.store, options.messageId, options.trace, {
      id: options.call.id,
      name: options.call.name,
      arguments: options.call.arguments,
      conversationId: options.conversationId,
      status: "error",
      output,
    });
    return { trace, pause: false, output };
  };

  if (options.call.name === ASK_USER_TOOL) {
    const parsed = readAskUser(options.call.arguments);
    if (!parsed) return refuse("ask_user requires a question and options.");
    await options.store.saveToolCall({
      id: options.call.id,
      conversationId: options.conversationId,
      messageId: options.messageId,
      name: options.call.name,
      arguments: JSON.stringify(parsed),
      status: "ask",
      output: null,
    });
    return { trace: options.trace, pause: true, output: "" };
  }

  const tool = options.tools.get(options.call.name);
  if (!tool) return refuse(`Unknown tool "${options.call.name}".`);
  const parsed = parseArguments(options.call.arguments);
  if (!parsed.ok) return refuse(parsed.error);

  let args = parsed.args;
  if (tool.prepare) {
    try {
      const prepared = tool.prepare(parsed.args);
      if ("error" in prepared) return refuse(prepared.error);
      args = prepared.args;
    } catch {
      return refuse("This tool was not run because its arguments could not be prepared.");
    }
  }

  let needsApproval: boolean;
  try {
    needsApproval = requiresApproval(tool, args);
  } catch {
    return refuse("This tool was not run because approval could not be checked.");
  }
  if (needsApproval) {
    await options.store.saveToolCall({
      id: options.call.id,
      conversationId: options.conversationId,
      messageId: options.messageId,
      name: options.call.name,
      arguments: JSON.stringify(args),
      status: "approval",
      output: null,
    });
    return { trace: options.trace, pause: true, output: "" };
  }

  const result = await runTool(tool, args, {
    promote: (names) => names.forEach((name) => options.promoted.add(name)),
  });
  const trace = await recordResult(options.store, options.messageId, options.trace, {
    id: options.call.id,
    name: options.call.name,
    arguments: JSON.stringify(args),
    conversationId: options.conversationId,
    status: result.isError ? "error" : "done",
    output: result.content,
  });
  return { trace, pause: false, output: result.content };
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
