import type { LlmProvider } from "../llm";
import type { ConversationStore } from "../store";
import { emptyTrace } from "../trace";
import type { Clock } from "./clock";
import type { RoutineStore } from "./store";
import { promptForRun, runRoutineTurn } from "./turn";

export type TickResult = { claimed: number; succeeded: number; failed: number };

const DEFAULT_LIMIT = 25;

function errorText(error: unknown): string {
  const message = error instanceof Error && error.message ? error.message : "Routine run failed";
  return message.slice(0, 2000);
}

async function recordFailure(
  store: ConversationStore,
  conversationId: string,
  text: string,
): Promise<string | null> {
  const loaded = await store.getConversation(conversationId);
  const last = loaded?.messages.at(-1);
  if (last?.role !== "user") return null;
  const failure = `Routine failed: ${text}`;
  const saved = await store.addMessage(conversationId, "assistant", failure, {
    ...emptyTrace(),
    started: true,
    role: "assistant",
    text: failure,
    ended: true,
    finishReason: "error",
  });
  return saved.id;
}

async function ensureConversation(
  store: ConversationStore,
  routines: RoutineStore,
  routineId: string,
  name: string,
  conversationId: string | null,
  now: Date,
): Promise<string> {
  if (conversationId) {
    const existing = await store.getConversation(conversationId);
    if (existing) return existing.conversation.id;
  }
  const created = await store.createConversation(name);
  await routines.setConversation(routineId, created.id, now);
  return created.id;
}

export async function tick(options: {
  routines: RoutineStore;
  store: ConversationStore;
  provider: LlmProvider;
  clock: Clock;
  workerId: string;
  limit?: number;
}): Promise<TickResult> {
  const now = options.clock.now();
  await options.routines.enqueueDue(now);
  const limit = options.limit ?? DEFAULT_LIMIT;
  const result: TickResult = { claimed: 0, succeeded: 0, failed: 0 };
  while (result.claimed < limit) {
    const job = await options.routines.claimNext(options.workerId, now);
    if (!job) break;
    result.claimed += 1;
    let conversationId: string | null = job.routine.conversationId;
    try {
      conversationId = await ensureConversation(
        options.store,
        options.routines,
        job.routine.id,
        job.routine.name,
        conversationId,
        now,
      );
      const event = job.run.eventId ? await options.routines.getEvent(job.run.eventId) : null;
      const turn = await runRoutineTurn({
        store: options.store,
        provider: options.provider,
        conversationId,
        prompt: promptForRun(job.routine.prompt, event),
      });
      const saved = await options.routines.finishRun(job.run.id, options.workerId, {
        status: "succeeded",
        finishedAt: options.clock.now(),
        conversationId,
        assistantMessageId: turn.assistantMessageId,
        error: null,
      });
      if (saved) result.succeeded += 1;
    } catch (error) {
      const text = errorText(error);
      let assistantMessageId: string | null = null;
      if (conversationId) {
        try {
          assistantMessageId = await recordFailure(options.store, conversationId, text);
        } catch {
          assistantMessageId = null;
        }
      }
      const saved = await options.routines.finishRun(job.run.id, options.workerId, {
        status: "failed",
        finishedAt: options.clock.now(),
        conversationId,
        assistantMessageId,
        error: text,
      });
      if (saved) result.failed += 1;
    }
  }
  return result;
}

export async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted || ms <= 0) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function runWorker(options: {
  routines: RoutineStore;
  store: ConversationStore;
  provider: LlmProvider;
  clock: Clock;
  workerId: string;
  pollMs: number;
  signal: AbortSignal;
  onTick?: (result: TickResult) => void;
  onError?: (error: unknown) => void;
}): Promise<void> {
  while (!options.signal.aborted) {
    try {
      const result = await tick(options);
      options.onTick?.(result);
    } catch (error) {
      if (options.onError) options.onError(error);
      else throw error;
    }
    if (options.signal.aborted) return;
    await sleep(options.pollMs, options.signal);
  }
}
