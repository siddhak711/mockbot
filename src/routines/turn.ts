import { SYSTEM_PROMPT, type LlmProvider } from "../llm";
import { RunLog, captureModelEvent, elapsedMs, emptyModelCapture } from "../runs/events";
import type { ConversationStore } from "../store";
import { applyStreamEvent, emptyTrace } from "../trace";
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
 * The only place a routine invokes the agent loop.
 * It stores the prompt and the finished reply on the routine's conversation.
 * Later milestones can replace this with the shared tool loop.
 */
export async function runRoutineTurn(options: {
  store: ConversationStore;
  provider: LlmProvider;
  conversationId: string;
  prompt: string;
  runId?: string;
}): Promise<{ assistantMessageId: string; text: string; runId: string }> {
  const log = new RunLog(options.store.connection, options.runId);
  await log.mark("run.started", { conversationId: options.conversationId });
  try {
    await options.store.addMessage(options.conversationId, "user", options.prompt);
    const stored = await options.store.getConversation(options.conversationId);
    if (!stored) throw new Error("Conversation disappeared before the routine ran");
    const history = modelMessages(stored.messages);
    let trace = emptyTrace();
    const capture = emptyModelCapture();
    const started = performance.now();
    for await (const event of options.provider.stream(history)) {
      captureModelEvent(capture, event);
      trace = applyStreamEvent(trace, event);
    }
    await log.recordModel({
      model: options.provider.model,
      messages: history,
      capture,
      ms: elapsedMs(started),
    });
    const assistant = await options.store.addMessage(
      options.conversationId,
      "assistant",
      trace.text,
      trace,
    );
    await log.mark("run.finished", { status: "completed", assistantMessageId: assistant.id });
    return { assistantMessageId: assistant.id, text: trace.text, runId: log.id };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Routine run failed";
    await log.fail(message);
    await log.mark("run.finished", { status: "error" });
    throw error;
  }
}

export function promptForRun(
  prompt: string,
  event: { name: string; payload: string | null } | null,
): string {
  if (!event?.payload) return prompt;
  return `${prompt}\n\nEvent ${event.name}:\n${event.payload}`;
}
