import { AgentDirectory } from "../agents/directory";
import { LEAD_AGENT_ID } from "../agents/ids";
import type { LlmProvider } from "../llm";
import type { ConversationStore } from "../store";
import { emptyTrace } from "../trace";
import type { Clock } from "./clock";
import type { RoutineStore } from "./store";
import { ROUTINE_STREAM_TIMEOUT_MS, promptForRun, runRoutineTurn } from "./turn";

export type TickResult = { claimed: number; succeeded: number; failed: number };

const DEFAULT_LIMIT = 25;
const DEFAULT_CONCURRENCY = 4;

/**
 * How long a claimed run may stay 'running' before another tick fails it.
 * Three stream timeouts, so a live worker that is merely slow is never reclaimed.
 */
export const ROUTINE_LEASE_MS = 3 * ROUTINE_STREAM_TIMEOUT_MS;

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

const conversationTurn = new Map<string, Promise<void>>();

/** One routine turn at a time per conversation, so an in-flight prompt is not dropped. */
async function withConversation<T>(conversationId: string, task: () => Promise<T>): Promise<T> {
  const previous = conversationTurn.get(conversationId) ?? Promise.resolve();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(
    () => gate,
    () => gate,
  );
  conversationTurn.set(conversationId, tail);
  await previous.catch(() => undefined);
  try {
    return await task();
  } finally {
    release();
    if (conversationTurn.get(conversationId) === tail) conversationTurn.delete(conversationId);
  }
}

/** The owner's lead, when the routine did not store an agent. */
async function ownerLead(store: ConversationStore, userId: string): Promise<string | null> {
  const result = await store.connection.query<{ id: string }>(
    `SELECT id
     FROM agents
     WHERE user_id = $1 AND is_lead = TRUE
     ORDER BY created_at ASC, id ASC
     LIMIT 1`,
    [userId],
  );
  return result.rows[0]?.id ?? null;
}

/**
 * Append the run to its owner's one thread. A routine that still has no owner
 * stays on the unscoped lead. A missing pointer is repaired.
 */
async function ensureConversation(
  store: ConversationStore,
  routines: RoutineStore,
  routine: { id: string; name: string; userId: string | null; agentId: string | null },
  conversationId: string | null,
  now: Date,
): Promise<string> {
  const userId = routine.userId;
  const agentId =
    routine.agentId ?? (userId ? await ownerLead(store, userId) : null) ?? LEAD_AGENT_ID;
  const conversation = await store.getOrCreateAgentConversation(agentId, userId);
  await store.nameIfEmpty(conversation.id, routine.name, userId);
  if (conversationId === conversation.id) return conversation.id;
  if (!conversationId) {
    const saved = await routines.setConversation(routine.id, conversation.id, now);
    if (!saved) throw new Error("Routine disappeared before its conversation was saved");
    return saved;
  }
  const existing = await store.getConversation(conversationId);
  if (existing?.conversation.id === conversation.id) return conversation.id;
  const moved = await routines.moveConversation(routine.id, conversation.id, now);
  if (!moved) throw new Error("Routine disappeared before its conversation was saved");
  return moved;
}

type TickOptions = {
  routines: RoutineStore;
  store: ConversationStore;
  provider: LlmProvider;
  clock: Clock;
  workerId: string;
  limit?: number;
  /** Runs worked at once. One stalled provider call no longer blocks the rest. */
  concurrency?: number;
  /** A run claimed longer ago than this is failed by the next tick. */
  leaseMs?: number;
  /** Upper bound on one model stream. Keep it well under the lease. */
  streamTimeoutMs?: number;
  agents?: AgentDirectory;
};

type Job = NonNullable<Awaited<ReturnType<RoutineStore["claimNext"]>>>;

async function runJob(
  options: TickOptions & { agents: AgentDirectory },
  job: Job,
  now: Date,
  result: TickResult,
): Promise<void> {
  let conversationId: string | null = job.routine.conversationId;
  try {
    conversationId = await ensureConversation(
      options.store,
      options.routines,
      job.routine,
      conversationId,
      now,
    );
    const activeConversation = conversationId;
    await withConversation(activeConversation, async () => {
      try {
        const event = job.run.eventId ? await options.routines.getEvent(job.run.eventId) : null;
        const turn = await runRoutineTurn({
          store: options.store,
          provider: options.provider,
          conversationId: activeConversation,
          prompt: promptForRun(job.routine.prompt, event),
          runId: job.run.id,
          agents: options.agents,
          timeoutMs: options.streamTimeoutMs,
        });
        const saved = await options.routines.finishRun(job.run.id, options.workerId, {
          status: "succeeded",
          finishedAt: options.clock.now(),
          conversationId: activeConversation,
          assistantMessageId: turn.assistantMessageId,
          error: null,
        });
        if (saved) result.succeeded += 1;
      } catch (error) {
        const text = errorText(error);
        let assistantMessageId: string | null = null;
        try {
          assistantMessageId = await recordFailure(options.store, activeConversation, text);
        } catch {
          // The run is still marked failed. The next turn skips an unanswered prompt.
        }
        const saved = await options.routines.finishRun(job.run.id, options.workerId, {
          status: "failed",
          finishedAt: options.clock.now(),
          conversationId: activeConversation,
          assistantMessageId,
          error: text,
        });
        if (saved) result.failed += 1;
      }
    });
  } catch (error) {
    const text = errorText(error);
    const saved = await options.routines.finishRun(job.run.id, options.workerId, {
      status: "failed",
      finishedAt: options.clock.now(),
      conversationId,
      assistantMessageId: null,
      error: text,
    });
    if (saved) result.failed += 1;
  }
}

export async function tick(options: TickOptions): Promise<TickResult> {
  const now = options.clock.now();
  await options.routines.reclaimStale(now, options.leaseMs ?? ROUTINE_LEASE_MS);
  await options.routines.enqueueDue(now);
  const limit = options.limit ?? DEFAULT_LIMIT;
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
  const agents = options.agents ?? (await AgentDirectory.attach(options.store));
  const result: TickResult = { claimed: 0, succeeded: 0, failed: 0 };
  let reserved = 0;
  let drained = false;
  const lane = async () => {
    while (!drained && reserved < limit) {
      reserved += 1;
      const job = await options.routines.claimNext(options.workerId, now);
      if (!job) {
        reserved -= 1;
        drained = true;
        return;
      }
      result.claimed += 1;
      // Runs of one routine keep their claim order across lanes.
      await withConversation(`routine:${job.routine.id}`, () =>
        runJob({ ...options, agents }, job, now, result),
      );
    }
  };
  await Promise.all(Array.from({ length: concurrency }, lane));
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

export async function runWorker(
  options: TickOptions & {
    pollMs: number;
    signal: AbortSignal;
    onTick?: (result: TickResult) => void;
    onError?: (error: unknown) => void;
  },
): Promise<void> {
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
