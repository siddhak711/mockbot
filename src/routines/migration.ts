/** Idempotent routines schema. Applied by RoutineStore, separate from conversation tables. */
export const ROUTINES_MIGRATION = `
CREATE TABLE IF NOT EXISTS routines (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  prompt TEXT NOT NULL,
  trigger_kind TEXT NOT NULL CHECK (trigger_kind IN ('cron', 'event')),
  cron TEXT,
  event_name TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
  conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  next_run_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT routines_trigger_shape CHECK (
    (
      trigger_kind = 'cron'
      AND cron IS NOT NULL
      AND event_name IS NULL
      AND next_run_at IS NOT NULL
    )
    OR (
      trigger_kind = 'event'
      AND event_name IS NOT NULL
      AND cron IS NULL
      AND next_run_at IS NULL
    )
  )
);

CREATE TABLE IF NOT EXISTS routine_events (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  payload TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS routine_events_name_idx ON routine_events (name, created_at);

CREATE TABLE IF NOT EXISTS routine_runs (
  id TEXT PRIMARY KEY,
  routine_id TEXT NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
  source TEXT NOT NULL CHECK (source IN ('cron', 'event')),
  event_id TEXT REFERENCES routine_events(id),
  scheduled_for TIMESTAMPTZ NOT NULL,
  claimed_by TEXT,
  claimed_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  conversation_id TEXT,
  assistant_message_id TEXT,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT routine_runs_event_link CHECK (
    (source = 'event' AND event_id IS NOT NULL)
    OR (source = 'cron' AND event_id IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS routine_runs_one_cron_occurrence
  ON routine_runs (routine_id, scheduled_for)
  WHERE source = 'cron';

CREATE UNIQUE INDEX IF NOT EXISTS routine_runs_one_event
  ON routine_runs (routine_id, event_id)
  WHERE event_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS routine_runs_claim_idx
  ON routine_runs (status, scheduled_for, id);

CREATE INDEX IF NOT EXISTS routines_due_idx
  ON routines (status, next_run_at);

CREATE INDEX IF NOT EXISTS routines_event_idx
  ON routines (event_name)
  WHERE trigger_kind = 'event';

ALTER TABLE routines ADD COLUMN IF NOT EXISTS user_id TEXT REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE routines ADD COLUMN IF NOT EXISTS agent_id TEXT;

CREATE INDEX IF NOT EXISTS routines_user_idx ON routines (user_id, created_at DESC);

-- Routines created before ownership stay with the earliest account's lead.
DO $$
BEGIN
  IF to_regclass('public.users') IS NOT NULL AND to_regclass('public.agents') IS NOT NULL THEN
    UPDATE routines AS routine
    SET user_id = owner.id,
        agent_id = owner.lead_id,
        updated_at = NOW()
    FROM (
      SELECT users.id AS id,
             (
               SELECT agents.id
               FROM agents
               WHERE agents.user_id = users.id
                 AND agents.is_lead = TRUE
               ORDER BY agents.created_at ASC, agents.id ASC
               LIMIT 1
             ) AS lead_id
      FROM users
      ORDER BY users.created_at ASC, users.id ASC
      LIMIT 1
    ) AS owner
    WHERE routine.user_id IS NULL
      AND owner.lead_id IS NOT NULL;
  END IF;
END $$;
`;
