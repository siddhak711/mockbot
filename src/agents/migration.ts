const AGENT_SCHEMA = `
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS agent_id TEXT NOT NULL DEFAULT 'agent_default';

CREATE INDEX IF NOT EXISTS conversations_agent_updated_idx ON conversations (agent_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  instructions TEXT NOT NULL,
  memory_note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  user_id TEXT,
  is_lead BOOLEAN NOT NULL DEFAULT FALSE
);

ALTER TABLE agents ADD COLUMN IF NOT EXISTS user_id TEXT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS is_lead BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE agents SET is_lead = TRUE WHERE id = 'agent_default' AND is_lead = FALSE;

DROP INDEX IF EXISTS agents_name_lower_idx;

CREATE UNIQUE INDEX IF NOT EXISTS agents_name_per_user_idx
  ON agents (user_id, lower(name))
  WHERE user_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS agents_name_unscoped_idx
  ON agents (lower(name))
  WHERE user_id IS NULL;

CREATE TABLE IF NOT EXISTS agent_grants (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  resource_kind TEXT NOT NULL CHECK (resource_kind IN ('connector', 'computer')),
  resource_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (agent_id, resource_kind, resource_id)
);
`;

type Executable = {
  exec(sql: string): Promise<unknown>;
};

export async function applyAgentSchema(db: Executable): Promise<void> {
  await db.exec(AGENT_SCHEMA);
}
