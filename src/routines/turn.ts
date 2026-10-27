import { AgentDirectory } from "../agents/directory";
import { NoteMemory } from "../agents/ports";
import { buildAgentSystemPrompt } from "../agents/prompt";
import type { AgentMemoryPort } from "../agents/types";
import { SYSTEM_PROMPT, type LlmProvider } from "../llm";
import {
  RunLog,
  captureModelEvent,
  elapsedMs,
  emptyModelCapture,
  ignoreRunLog,
} from "../runs/events";
import type { ConversationStore } from "../store";
import { applyStreamEvent, emptyTrace } from "../trace";
import { buildModelInput } from "../turn";
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

/** Keep the prepared system prompt, and drop an abandoned user turn from the rest. */
function routineHistory(prepared: LlmMessage[]): LlmMessage[] {
  const system = prepared.filter((message) => message.role === "system");
  const turns: Array<{ role: Role; content: string }> = [];
  for (const message of prepared) {
    if (message.role === "user" || message.role === "assistant") {
      turns.push({ role: message.role, content: message.content });
    }
  }
  const kept = modelMessages(turns).filter((message) => message.role !== "system");
  return [...system, ...kept];
}

/** A model stream that runs longer than this is aborted, so a stalled provider frees the worker. */
export const ROUTINE_STREAM_TIMEOUT_MS = 5 * 60_000;

function timeoutError(ms: number): Error {
  return new Error(`Routine model call timed out after ${Math.round(ms / 1000)}s`);
}

/**
 * Stop iterating when the signal fires, even if the provider ignores it.
 * A provider that never yields again would otherwise hold the worker forever.
 */
async function* untilAborted<T>(
  source: AsyncIterable<T>,
  signal: AbortSignal,
  reason: () => Error,
): AsyncIterable<T> {
  const iterator = source[Symbol.asyncIterator]();
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(reason());
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  aborted.catch(() => undefined);
  try {
    while (true) {
      const next = await Promise.race([iterator.next(), aborted]);
      if (next.done) return;
      yield next.value;
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    void Promise.resolve(iterator.return?.()).catch(() => undefined);
  }
}

/**
 * The only place a routine invokes the agent loop.
 * It stores the prompt and the finished reply on the routine's conversation.
 * The system prompt carries the target agent's instructions, memory note, and
 * grants, as chat and delegate build it. Tools are not offered: the shared
 * tool loop lives in the chat route and the worker cannot reach it yet.
 */
export async function runRoutineTurn(options: {
  store: ConversationStore;
  provider: LlmProvider;
  conversationId: string;
  prompt: string;
  runId?: string;
  agents?: AgentDirectory;
  memory?: AgentMemoryPort;
  timeoutMs?: number;
}): Promise<{ assistantMessageId: string; text: string; runId: string }> {
  const log = new RunLog(options.store.connection, options.runId);
  await ignoreRunLog(log.mark("run.started", { conversationId: options.conversationId }));
  try {
    await options.store.addMessage(options.conversationId, "user", options.prompt);
    const stored = await options.store.getConversation(options.conversationId);
    if (!stored) throw new Error("Conversation disappeared before the routine ran");
    const agents = options.agents ?? (await AgentDirectory.attach(options.store));
    const memory = options.memory ?? new NoteMemory(agents);
    const speaker = (await agents.get(stored.conversation.agentId)) ?? (await agents.lead());
    if (!speaker) throw new Error("Agent not found");
    const [memories, grants] = await Promise.all([
      memory.list(speaker.id),
      agents.listGrants(speaker.id),
    ]);
    const prepared = await buildModelInput({
      store: options.store,
      conversationId: options.conversationId,
      agentId: stored.conversation.agentId,
      agentPrompt: buildAgentSystemPrompt({ agent: speaker, memories, grants, child: false }),
    });
    if (!prepared) throw new Error("Conversation disappeared before the routine ran");
    const history = routineHistory(prepared.messages);
    let trace = emptyTrace();
    const capture = emptyModelCapture();
    const started = performance.now();
    const timeoutMs = options.timeoutMs ?? ROUTINE_STREAM_TIMEOUT_MS;
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      const events = options.provider.stream(history, { signal });
      for await (const event of untilAborted(events, signal, () => timeoutError(timeoutMs))) {
        captureModelEvent(capture, event);
        trace = applyStreamEvent(trace, event);
      }
      // A provider that honors the signal may end quietly instead of throwing.
      if (signal.aborted) throw timeoutError(timeoutMs);
    } finally {
      await ignoreRunLog(
        log.recordModel({
          model: options.provider.model,
          messages: history,
          capture,
          ms: elapsedMs(started),
        }),
      );
    }
    const assistant = await options.store.addMessage(
      options.conversationId,
      "assistant",
      trace.text,
      trace,
    );
    await ignoreRunLog(
      log.mark("run.finished", { status: "completed", assistantMessageId: assistant.id }),
    );
    return { assistantMessageId: assistant.id, text: trace.text, runId: log.id };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Routine run failed";
    await ignoreRunLog(log.fail(message));
    await ignoreRunLog(log.mark("run.finished", { status: "error" }));
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
