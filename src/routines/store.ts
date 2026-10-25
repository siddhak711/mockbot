import type { PGlite, Transaction } from "@electric-sql/pglite";
import type { ConversationStore } from "../store";
import { CronError, nextCron } from "./cron";
import { ROUTINES_MIGRATION } from "./migration";
import type { Routine, RoutineEvent, RoutineRun, RoutineStatus } from "./types";
import {
  RoutineInputError,
  validateCron,
  validateEventName,
  validateName,
  validatePayload,
  validatePrompt,
} from "./validate";

type Queryable = Pick<PGlite, "query"> | Transaction;

type RoutineRow = {
  id: string;
  name: string;
  prompt: string;
  trigger_kind: "cron" | "event";
  cron: string | null;
  event_name: string | null;
  status: RoutineStatus;
  conversation_id: string | null;
  next_run_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

type RunRow = {
  id: string;
  routine_id: string;
  status: RoutineRun["status"];
  source: RoutineRun["source"];
  event_id: string | null;
  scheduled_for: Date | string;
  claimed_by: string | null;
  claimed_at: Date | string | null;
  started_at: Date | string | null;
  finished_at: Date | string | null;
  conversation_id: string | null;
  assistant_message_id: string | null;
  error: string | null;
  created_at: Date | string;
  result_excerpt: string | null;
};

type EventRow = {
  id: string;
  name: string;
  payload: string | null;
  created_at: Date | string;
};

const RUN_COLUMNS = `
  run.id, run.routine_id, run.status, run.source, run.event_id, run.scheduled_for,
  run.claimed_by, run.claimed_at, run.started_at, run.finished_at, run.conversation_id,
  run.assistant_message_id, run.error, run.created_at,
  LEFT(messages.content, 280) AS result_excerpt
`;

function asIso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  return date.toISOString();
}

function asIsoOrNull(value: Date | string | null): string | null {
  if (value == null) return null;
  return asIso(value);
}

function mapRoutine(row: RoutineRow): Routine {
  const trigger =
    row.trigger_kind === "cron"
      ? { kind: "cron" as const, cron: row.cron ?? "" }
      : { kind: "event" as const, eventName: row.event_name ?? "" };
  return {
    id: row.id,
    name: row.name,
    prompt: row.prompt,
    trigger,
    status: row.status,
    conversationId: row.conversation_id,
    nextRunAt: asIsoOrNull(row.next_run_at),
    createdAt: asIso(row.created_at),
    updatedAt: asIso(row.updated_at),
  };
}

function mapRun(row: RunRow): RoutineRun {
  return {
    id: row.id,
    routineId: row.routine_id,
    status: row.status,
    source: row.source,
    eventId: row.event_id,
    scheduledFor: asIso(row.scheduled_for),
    claimedBy: row.claimed_by,
    claimedAt: asIsoOrNull(row.claimed_at),
    startedAt: asIsoOrNull(row.started_at),
    finishedAt: asIsoOrNull(row.finished_at),
    conversationId: row.conversation_id,
    assistantMessageId: row.assistant_message_id,
    error: row.error,
    createdAt: asIso(row.created_at),
    resultExcerpt: row.result_excerpt,
  };
}

function mapEvent(row: EventRow): RoutineEvent {
  return {
    id: row.id,
    name: row.name,
    payload: row.payload,
    createdAt: asIso(row.created_at),
  };
}

async function query<T>(db: Queryable, sql: string, params: unknown[] = []): Promise<T[]> {
  const result = await db.query<T>(sql, params);
  return result.rows;
}

export type NewRoutine = {
  name: string;
  prompt: string;
  now: Date;
  cron?: string;
  eventName?: string;
};

export type FinishInput = {
  status: "succeeded" | "failed";
  finishedAt: Date;
  conversationId: string | null;
  assistantMessageId: string | null;
  error: string | null;
};

export class RoutineStore {
  private constructor(private readonly conversations: ConversationStore) {}

  static async attach(conversations: ConversationStore): Promise<RoutineStore> {
    await conversations.connection.exec(ROUTINES_MIGRATION);
    return new RoutineStore(conversations);
  }

  private get db(): PGlite {
    return this.conversations.connection;
  }

  async create(input: NewRoutine): Promise<Routine> {
    const name = validateName(input.name);
    const prompt = validatePrompt(input.prompt);
    const hasCron = input.cron != null && input.cron.trim() !== "";
    const hasEvent = input.eventName != null && input.eventName.trim() !== "";
    if (hasCron === hasEvent) {
      throw new RoutineInputError("Choose a cron schedule or an event name.");
    }
    const id = crypto.randomUUID();
    if (hasCron) {
      const cron = validateCron(input.cron ?? "");
      let next: Date;
      try {
        next = nextCron(cron, input.now);
      } catch (error) {
        if (error instanceof CronError) throw new RoutineInputError(error.message);
        throw error;
      }
      const rows = await query<RoutineRow>(
        this.db,
        `INSERT INTO routines (
             id, name, prompt, trigger_kind, cron, status, next_run_at, created_at, updated_at
           ) VALUES ($1, $2, $3, 'cron', $4, 'active', $5, $6, $6)
           RETURNING id, name, prompt, trigger_kind, cron, event_name, status, conversation_id,
                     next_run_at, created_at, updated_at`,
        [id, name, prompt, cron, next, input.now],
      );
      const row = rows[0];
      if (!row) throw new Error("Failed to create routine");
      return mapRoutine(row);
    }
    const eventName = validateEventName(input.eventName ?? "");
    const rows = await query<RoutineRow>(
      this.db,
      `INSERT INTO routines (
           id, name, prompt, trigger_kind, event_name, status, created_at, updated_at
         ) VALUES ($1, $2, $3, 'event', $4, 'active', $5, $5)
         RETURNING id, name, prompt, trigger_kind, cron, event_name, status, conversation_id,
                   next_run_at, created_at, updated_at`,
      [id, name, prompt, eventName, input.now],
    );
    const row = rows[0];
    if (!row) throw new Error("Failed to create routine");
    return mapRoutine(row);
  }

  async list(): Promise<Routine[]> {
    const rows = await query<RoutineRow>(
      this.db,
      `SELECT id, name, prompt, trigger_kind, cron, event_name, status, conversation_id,
              next_run_at, created_at, updated_at
       FROM routines
       ORDER BY created_at DESC, id DESC`,
    );
    return rows.map(mapRoutine);
  }

  async get(id: string): Promise<Routine | null> {
    const rows = await query<RoutineRow>(
      this.db,
      `SELECT id, name, prompt, trigger_kind, cron, event_name, status, conversation_id,
              next_run_at, created_at, updated_at
       FROM routines
       WHERE id = $1`,
      [id],
    );
    const row = rows[0];
    return row ? mapRoutine(row) : null;
  }

  async setStatus(id: string, status: RoutineStatus, now: Date): Promise<Routine | null> {
    const rows = await query<RoutineRow>(
      this.db,
      `UPDATE routines
       SET status = $2, updated_at = $3
       WHERE id = $1
       RETURNING id, name, prompt, trigger_kind, cron, event_name, status, conversation_id,
                 next_run_at, created_at, updated_at`,
      [id, status, now],
    );
    const row = rows[0];
    return row ? mapRoutine(row) : null;
  }

  /**
   * Store this conversation only while the routine still has none.
   * The id read back may belong to a run that won the update.
   */
  async setConversation(id: string, conversationId: string, now: Date): Promise<string | null> {
    await this.db.query(
      `UPDATE routines
       SET conversation_id = $2, updated_at = $3
       WHERE id = $1 AND conversation_id IS NULL`,
      [id, conversationId, now],
    );
    const saved = await this.get(id);
    return saved?.conversationId ?? null;
  }

  async listRuns(routineId: string, limit = 50): Promise<RoutineRun[]> {
    const rows = await query<RunRow>(
      this.db,
      `SELECT ${RUN_COLUMNS}
       FROM routine_runs run
       LEFT JOIN messages ON messages.id = run.assistant_message_id
       WHERE run.routine_id = $1
       ORDER BY run.scheduled_for DESC, run.created_at DESC, run.id DESC
       LIMIT $2`,
      [routineId, limit],
    );
    return rows.map(mapRun);
  }

  async getEvent(id: string): Promise<RoutineEvent | null> {
    const rows = await query<EventRow>(
      this.db,
      `SELECT id, name, payload, created_at FROM routine_events WHERE id = $1`,
      [id],
    );
    const row = rows[0];
    return row ? mapEvent(row) : null;
  }

  /** Insert one pending run per due cron occurrence and move next_run_at forward. */
  async enqueueDue(now: Date): Promise<number> {
    const due = await query<RoutineRow>(
      this.db,
      `SELECT id, name, prompt, trigger_kind, cron, event_name, status, conversation_id,
              next_run_at, created_at, updated_at
       FROM routines
       WHERE status = 'active'
         AND trigger_kind = 'cron'
         AND next_run_at IS NOT NULL
         AND next_run_at <= $1
       ORDER BY next_run_at, id`,
      [now],
    );
    let created = 0;
    for (const routine of due) {
      if (!routine.cron || !routine.next_run_at) continue;
      const scheduledFor = new Date(routine.next_run_at);
      const next = nextCron(routine.cron, now);
      const runId = crypto.randomUUID();
      const inserted = await this.db.transaction(async (tx) => {
        const rows = await query<{ id: string }>(
          tx,
          `INSERT INTO routine_runs (
             id, routine_id, status, source, scheduled_for, created_at
           ) VALUES ($1, $2, 'pending', 'cron', $3, $4)
           ON CONFLICT (routine_id, scheduled_for) WHERE source = 'cron' DO NOTHING
           RETURNING id`,
          [runId, routine.id, scheduledFor, now],
        );
        await tx.query(
          `UPDATE routines
           SET next_run_at = $2, updated_at = $3
           WHERE id = $1 AND next_run_at <= $3`,
          [routine.id, next, now],
        );
        return rows.length > 0;
      });
      if (inserted) created += 1;
    }
    return created;
  }

  /**
   * Claim one pending run. A second worker gets nothing: the update matches
   * only a pending row and skips rows another transaction already locked.
   */
  async claimNext(
    workerId: string,
    now: Date,
  ): Promise<{ run: RoutineRun; routine: Routine } | null> {
    const claimed = await query<RunRow>(
      this.db,
      `WITH next AS (
         SELECT run.id
         FROM routine_runs run
         JOIN routines ON routines.id = run.routine_id
         WHERE run.status = 'pending'
           AND routines.status = 'active'
           AND run.scheduled_for <= $2
         ORDER BY run.scheduled_for, run.id
         FOR UPDATE OF run SKIP LOCKED
         LIMIT 1
       )
       UPDATE routine_runs
       SET status = 'running', claimed_by = $1, claimed_at = $2, started_at = $2
       FROM next
       WHERE routine_runs.id = next.id
         AND routine_runs.status = 'pending'
       RETURNING routine_runs.id, routine_runs.routine_id, routine_runs.status, routine_runs.source,
                 routine_runs.event_id, routine_runs.scheduled_for, routine_runs.claimed_by,
                 routine_runs.claimed_at, routine_runs.started_at, routine_runs.finished_at,
                 routine_runs.conversation_id, routine_runs.assistant_message_id,
                 routine_runs.error, routine_runs.created_at, NULL::text AS result_excerpt`,
      [workerId, now],
    );
    const row = claimed[0];
    if (!row) return null;
    const routine = await this.get(row.routine_id);
    if (!routine) return null;
    return { run: mapRun(row), routine };
  }

  async finishRun(runId: string, workerId: string, outcome: FinishInput): Promise<boolean> {
    const rows = await query<{ id: string }>(
      this.db,
      `UPDATE routine_runs
       SET status = $3,
           finished_at = $4,
           conversation_id = $5,
           assistant_message_id = $6,
           error = $7
       WHERE id = $1 AND claimed_by = $2 AND status = 'running'
       RETURNING id`,
      [
        runId,
        workerId,
        outcome.status,
        outcome.finishedAt,
        outcome.conversationId,
        outcome.assistantMessageId,
        outcome.error,
      ],
    );
    return rows.length > 0;
  }

  /** Insert an event and one pending run for each active routine listening for that name. */
  async recordEvent(input: {
    name: string;
    payload?: string | null;
    now: Date;
  }): Promise<{ event: RoutineEvent; runs: RoutineRun[] }> {
    const name = validateEventName(input.name);
    const payload = validatePayload(input.payload);
    const eventId = crypto.randomUUID();
    return this.db.transaction(async (tx) => {
      const events = await query<EventRow>(
        tx,
        `INSERT INTO routine_events (id, name, payload, created_at)
         VALUES ($1, $2, $3, $4)
         RETURNING id, name, payload, created_at`,
        [eventId, name, payload, input.now],
      );
      const eventRow = events[0];
      if (!eventRow) throw new Error("Failed to store event");
      const listeners = await query<{ id: string }>(
        tx,
        `SELECT id
         FROM routines
         WHERE status = 'active' AND trigger_kind = 'event' AND event_name = $1
         ORDER BY id`,
        [name],
      );
      const runs: RoutineRun[] = [];
      for (const listener of listeners) {
        const runId = crypto.randomUUID();
        const inserted = await query<RunRow>(
          tx,
          `INSERT INTO routine_runs (
             id, routine_id, status, source, event_id, scheduled_for, created_at
           ) VALUES ($1, $2, 'pending', 'event', $3, $4, $4)
           ON CONFLICT (routine_id, event_id) WHERE event_id IS NOT NULL DO NOTHING
           RETURNING id, routine_id, status, source, event_id, scheduled_for, claimed_by,
                     claimed_at, started_at, finished_at, conversation_id, assistant_message_id,
                     error, created_at, NULL::text AS result_excerpt`,
          [runId, listener.id, eventId, input.now],
        );
        const row = inserted[0];
        if (row) runs.push(mapRun(row));
      }
      return { event: mapEvent(eventRow), runs };
    });
  }
}
