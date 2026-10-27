export type Migration = { id: string; sql: string };

export const MIGRATIONS: readonly Migration[] = [
  {
    id: "001_conversations",
    sql: `
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS messages (
  seq BIGSERIAL PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS messages_conversation_idx ON messages (conversation_id, seq);
`,
  },
  {
    id: "002_memory",
    sql: `
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS agent_id TEXT NOT NULL DEFAULT 'agent_default';

CREATE INDEX IF NOT EXISTS conversations_agent_updated_idx ON conversations (agent_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('profile', 'fact')),
  key TEXT NOT NULL,
  content TEXT NOT NULL,
  source_msg TEXT,
  supersedes TEXT,
  valid_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  valid_to TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  created_by TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS memories_agent_live_idx
  ON memories (agent_id, valid_from DESC)
  WHERE deleted_at IS NULL AND valid_to IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS memories_one_live_key_idx
  ON memories (agent_id, lower(key))
  WHERE deleted_at IS NULL AND valid_to IS NULL;

CREATE INDEX IF NOT EXISTS memories_agent_key_idx
  ON memories (agent_id, lower(key), valid_from DESC);

CREATE INDEX IF NOT EXISTS memories_content_fts
  ON memories USING GIN (to_tsvector('english', content));

CREATE TABLE IF NOT EXISTS conversation_summaries (
  conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  summary TEXT NOT NULL,
  upto_msg TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`,
  },
  {
    id: "003_tool_trace",
    sql: `
ALTER TABLE messages ADD COLUMN IF NOT EXISTS trace JSONB;

CREATE TABLE IF NOT EXISTS tool_calls (
  seq BIGSERIAL PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  arguments TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('running', 'approval', 'done', 'denied', 'error')),
  output TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS tool_calls_message_idx ON tool_calls (message_id, seq);
`,
  },
  {
    id: "004_connectors",
    sql: `
CREATE TABLE IF NOT EXISTS connectors (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  transport TEXT NOT NULL CHECK (transport IN ('http', 'stdio')),
  target TEXT NOT NULL,
  secret_ref TEXT,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`,
  },
  {
    id: "005_connector_tools",
    sql: `
ALTER TABLE connectors ADD COLUMN IF NOT EXISTS catalog_id TEXT;
ALTER TABLE connectors ADD COLUMN IF NOT EXISTS auth_type TEXT NOT NULL DEFAULT 'none';
ALTER TABLE connectors ADD COLUMN IF NOT EXISTS account_label TEXT;
ALTER TABLE connectors ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'connected';
ALTER TABLE connectors ADD COLUMN IF NOT EXISTS status_detail TEXT;
ALTER TABLE connectors ADD COLUMN IF NOT EXISTS tools JSONB NOT NULL DEFAULT '{}';
ALTER TABLE connectors ADD COLUMN IF NOT EXISTS seen_tools JSONB NOT NULL DEFAULT '[]';
ALTER TABLE connectors ADD COLUMN IF NOT EXISTS failures JSONB NOT NULL DEFAULT '[]';
ALTER TABLE connectors ADD COLUMN IF NOT EXISTS secret_cipher TEXT;
`,
  },
  {
    id: "006_auth",
    sql: `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT,
  email TEXT NOT NULL,
  email_verified TIMESTAMPTZ,
  image TEXT,
  password_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_idx ON users (lower(email));

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_account_id TEXT NOT NULL,
  refresh_token TEXT,
  access_token TEXT,
  expires_at BIGINT,
  token_type TEXT,
  scope TEXT,
  id_token TEXT,
  session_state TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (provider, provider_account_id)
);

CREATE INDEX IF NOT EXISTS accounts_user_idx ON accounts (user_id);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  session_token TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);

CREATE TABLE IF NOT EXISTS verification_tokens (
  identifier TEXT NOT NULL,
  token TEXT NOT NULL,
  expires TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (identifier, token)
);

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS user_id TEXT REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS user_id TEXT REFERENCES users(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS conversations_user_updated_idx ON conversations (user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS memories_user_idx ON memories (user_id, agent_id);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  instructions TEXT NOT NULL,
  memory_note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  is_lead BOOLEAN NOT NULL DEFAULT FALSE
);

ALTER TABLE agents ADD COLUMN IF NOT EXISTS user_id TEXT REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS is_lead BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE agents SET is_lead = TRUE WHERE id = 'agent_default' AND is_lead = FALSE;

CREATE INDEX IF NOT EXISTS agents_user_idx ON agents (user_id, created_at ASC);

DROP INDEX IF EXISTS agents_name_lower_idx;

CREATE UNIQUE INDEX IF NOT EXISTS agents_name_per_user_idx
  ON agents (user_id, lower(name))
  WHERE user_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS agents_name_unscoped_idx
  ON agents (lower(name))
  WHERE user_id IS NULL;
`,
  },
  {
    id: "007_composio_connections",
    sql: `
CREATE TABLE IF NOT EXISTS composio_connections (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  catalog_id TEXT NOT NULL,
  toolkit TEXT NOT NULL,
  connected_account_id TEXT NOT NULL,
  account_label TEXT,
  status TEXT NOT NULL DEFAULT 'connected',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, catalog_id)
);

CREATE INDEX IF NOT EXISTS composio_connections_user_idx
  ON composio_connections (user_id);
`,
  },
  {
    id: "008_connector_catalog",
    sql: `
DO $dedupe_catalog_connectors$
DECLARE
  catalog_key TEXT;
  keeper TEXT;
  loser RECORD;
BEGIN
  FOR catalog_key IN
    SELECT catalog_id
    FROM connectors
    WHERE catalog_id IS NOT NULL
    GROUP BY catalog_id
    HAVING COUNT(*) > 1
  LOOP
    SELECT id INTO keeper
    FROM connectors
    WHERE catalog_id = catalog_key
    ORDER BY created_at ASC, id ASC
    LIMIT 1;

    FOR loser IN
      SELECT id, tools, seen_tools
      FROM connectors
      WHERE catalog_id = catalog_key AND id <> keeper
      ORDER BY created_at ASC, id ASC
    LOOP
      UPDATE connectors
      SET tools = COALESCE(loser.tools, '{}'::jsonb) || COALESCE(tools, '{}'::jsonb),
          seen_tools = (
            SELECT COALESCE(jsonb_agg(DISTINCT item), '[]'::jsonb)
            FROM (
              SELECT jsonb_array_elements(
                CASE
                  WHEN jsonb_typeof(COALESCE(connectors.seen_tools, '[]'::jsonb)) = 'array'
                  THEN COALESCE(connectors.seen_tools, '[]'::jsonb)
                  ELSE '[]'::jsonb
                END
              ) AS item
              UNION ALL
              SELECT jsonb_array_elements(
                CASE
                  WHEN jsonb_typeof(COALESCE(loser.seen_tools, '[]'::jsonb)) = 'array'
                  THEN COALESCE(loser.seen_tools, '[]'::jsonb)
                  ELSE '[]'::jsonb
                END
              )
            ) items
          )
      WHERE id = keeper;

      IF to_regclass('public.agent_grants') IS NOT NULL THEN
        UPDATE agent_grants AS grant_row
        SET resource_id = keeper
        WHERE grant_row.resource_kind = 'connector'
          AND grant_row.resource_id = loser.id
          AND NOT EXISTS (
            SELECT 1
            FROM agent_grants AS existing
            WHERE existing.agent_id = grant_row.agent_id
              AND existing.resource_kind = 'connector'
              AND existing.resource_id = keeper
          );
        DELETE FROM agent_grants
        WHERE resource_kind = 'connector' AND resource_id = loser.id;
      END IF;
    END LOOP;

    -- composio_connections are keyed by catalog_id, not connector id.
    -- Removing the extra connector rows leaves those links in place.
    DELETE FROM connectors
    WHERE catalog_id = catalog_key AND id <> keeper;
  END LOOP;
END
$dedupe_catalog_connectors$;

CREATE UNIQUE INDEX IF NOT EXISTS connectors_catalog_id_idx
  ON connectors (catalog_id)
  WHERE catalog_id IS NOT NULL;
`,
  },
  // 011_run_events. main already has 007_composio_connections and 008_connector_catalog.
  // PR #32 claims 009_one_thread_per_agent and PR #37 claims 010_ask_user.
  // This id stays 011 so schema_migrations does not collide with those.
  // A preview already applied this table as 007_run_events. That SQL has the
  // same columns, check, and primary key as this one, so every statement below
  // is a no-op on that table. The stray schema_migrations row is removed.
  {
    id: "011_run_events",
    sql: `
CREATE TABLE IF NOT EXISTS run_events (
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('model', 'tool', 'event', 'error')),
  input TEXT,
  output TEXT,
  tokens INTEGER,
  cost_usd DOUBLE PRECISION,
  ms INTEGER,
  PRIMARY KEY (run_id, seq)
);

ALTER TABLE run_events ADD COLUMN IF NOT EXISTS run_id TEXT;
ALTER TABLE run_events ADD COLUMN IF NOT EXISTS seq INTEGER;
ALTER TABLE run_events ADD COLUMN IF NOT EXISTS type TEXT;
ALTER TABLE run_events ADD COLUMN IF NOT EXISTS input TEXT;
ALTER TABLE run_events ADD COLUMN IF NOT EXISTS output TEXT;
ALTER TABLE run_events ADD COLUMN IF NOT EXISTS tokens INTEGER;
ALTER TABLE run_events ADD COLUMN IF NOT EXISTS cost_usd DOUBLE PRECISION;
ALTER TABLE run_events ADD COLUMN IF NOT EXISTS ms INTEGER;

CREATE UNIQUE INDEX IF NOT EXISTS run_events_pkey ON run_events (run_id, seq);

DO $run_events_constraints$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.run_events'::regclass
      AND conname = 'run_events_type_check'
  ) THEN
    ALTER TABLE run_events
      ADD CONSTRAINT run_events_type_check
      CHECK (type IN ('model', 'tool', 'event', 'error'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.run_events'::regclass
      AND contype = 'p'
  ) THEN
    ALTER TABLE run_events
      ADD CONSTRAINT run_events_pkey PRIMARY KEY (run_id, seq);
  END IF;
END
$run_events_constraints$;

DELETE FROM schema_migrations WHERE id = '007_run_events';
`,
  },
];
