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
];
