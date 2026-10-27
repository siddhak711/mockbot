import { SYSTEM_PROMPT, type LlmProvider } from "../llm";
import type { ConversationStore } from "../store";
import { streamChatTurn } from "../chat";
import { SseParser } from "../sse";
import { ApprovalGate } from "../tools/approval";
import { AskGate, askUserTool } from "../tools/ask-user";
import { PlanGate } from "../tools/plan";
import { ToolRegistry } from "../tools/registry";
import type { LlmMessage, Role } from "../types";

/**
 * Drop a user message that never received an assistant reply. A failed run can
 * leave one of those behind, and the next run must not send it as history.
 * The newest user message is the prompt for this turn, so it stays.
 */
export function modelMessages(messages: Array<{ role: Role; content: string }>): LlmMessage[] {
  const visible = messages.filter((message) => message.content.length > 0);
  const kept = visible.filter((message, index) => {
    if (message.role !== "user") return true;
    for (let next = index + 1; next < visible.length; next += 1) {
      const later = visible[next];
      if (!later) continue;
      if (later.role === "assistant") return true;
      if (later.role === "user") return false;
    }
    return true;
  });
  return [
    { role: "system", content: SYSTEM_PROMPT },
    ...kept.map((message) => ({ role: message.role, content: message.content })),
  ];
}

/**
 * The only place a routine invokes the agent loop. It runs the same chat turn
 * a person's message runs, marked unattended: ask_user and approval-gated tools
 * return at once instead of waiting for somebody who is not there.
 */
export async function runRoutineTurn(options: {
  store: ConversationStore;
  provider: LlmProvider;
  conversationId: string;
  prompt: string;
  runId?: string;
  /** Tools the routine may call. Defaults to ask_user only, which unattended runs refuse. */
  tools?: ToolRegistry;
}): Promise<{ assistantMessageId: string; text: string; runId: string }> {
  const tools = options.tools ?? routineTools();
  const runId = options.runId ?? `run_${crypto.randomUUID()}`;
  const response = await streamChatTurn({
    store: options.store,
    provider: options.provider,
    tools,
    approvals: new ApprovalGate(),
    asks: new AskGate(),
    plans: new PlanGate(),
    unattended: true,
    runId,
    conversationId: options.conversationId,
    message: options.prompt,
  });
  if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? "Routine run failed");
  }
  let assistantMessageId: string | null = null;
  let failure: string | null = null;
  const parser = new SseParser();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const message of parser.push(decoder.decode(value, { stream: true }))) {
      const data = JSON.parse(message.data) as { assistantMessageId?: string; message?: string };
      if (message.event === "done") assistantMessageId = data.assistantMessageId ?? null;
      if (message.event === "error") failure = data.message ?? "Routine run failed";
    }
  }
  if (failure) throw new Error(failure);
  if (!assistantMessageId) throw new Error("The routine produced no reply");
  const stored = await options.store.getConversation(options.conversationId);
  const reply = stored?.messages.find((message) => message.id === assistantMessageId);
  return { assistantMessageId, text: reply?.content ?? "", runId };
}

function routineTools(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(askUserTool());
  return registry;
}

export function promptForRun(
  prompt: string,
  event: { name: string; payload: string | null } | null,
): string {
  if (!event?.payload) return prompt;
  return `${prompt}\n\nEvent ${event.name}:\n${event.payload}`;
}
