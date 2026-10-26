import { openDatabase, type ProcessEnv } from "../db/open";
import { openPglite } from "../db/pglite";
import type { Sql, SqlDriver } from "../db/sql";
import type { ComputerInfo, ComputerToolName, SandboxProviderKind, SandboxRun } from "./types";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS computers (
  agent_id TEXT PRIMARY KEY,
  id TEXT NOT NULL,
  provider TEXT NOT NULL,
  sandbox_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sandbox_files (
  agent_id TEXT NOT NULL,
  path TEXT NOT NULL,
  content TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (agent_id, path)
);

CREATE TABLE IF NOT EXISTS sandbox_runs (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  command TEXT,
  arguments JSONB NOT NULL,
  stdout TEXT NOT NULL,
  stderr TEXT NOT NULL,
  exit_code INTEGER,
  timed_out BOOLEAN NOT NULL,
  changed_files JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS sandbox_runs_agent_idx ON sandbox_runs (agent_id, created_at DESC, id DESC);
`;

type ComputerRow = {
  agent_id: string;
  id: string;
  provider: SandboxProviderKind;
  sandbox_id: string | null;
  created_at: Date | string;
};

type RunRow = {
  id: string;
  agent_id: string;
  tool: ComputerToolName;
  command: string | null;
  arguments: unknown;
  stdout: string;
  stderr: string;
  exit_code: number | null;
  timed_out: boolean;
  changed_files: unknown;
  created_at: Date | string;
};

function asIso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  return date.toISOString();
}

function asRecord(value: unknown): Record<string, string> {
  const source = typeof value === "string" ? safeParse(value) : value;
  if (!source || typeof source !== "object" || Array.isArray(source)) return {};
  const record: Record<string, string> = {};
  for (const [key, item] of Object.entries(source)) {
    if (typeof item === "string") record[key] = item;
  }
  return record;
}

function asStringList(value: unknown): string[] {
  const source = typeof value === "string" ? safeParse(value) : value;
  if (!Array.isArray(source)) return [];
  return source.filter((item): item is string => typeof item === "string");
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function mapComputer(row: ComputerRow): ComputerInfo & { sandboxId: string | null } {
  return {
    id: row.id,
    agentId: row.agent_id,
    provider: row.provider,
    sandboxId: row.sandbox_id,
    createdAt: asIso(row.created_at),
  };
}

function mapRun(row: RunRow): SandboxRun {
  return {
    id: row.id,
    agentId: row.agent_id,
    tool: row.tool,
    command: row.command,
    arguments: asRecord(row.arguments),
    stdout: row.stdout,
    stderr: row.stderr,
    exitCode: row.exit_code,
    timedOut: row.timed_out,
    changedFiles: asStringList(row.changed_files),
    createdAt: asIso(row.created_at),
  };
}

export class SandboxStore {
  readonly driver: SqlDriver;

  private constructor(private readonly db: Sql) {
    this.driver = db.driver;
  }

  /** Shared database connection. Tables are created on first open. */
  get connection(): Sql {
    return this.db;
  }

  /** Embedded Postgres for dev and tests. `memory://` stays in memory. */
  static async open(dataDir = "memory://"): Promise<SandboxStore> {
    return SandboxStore.fromSql(await openPglite(dataDir));
  }

  /** Shared Postgres from openDatabase. Creates the sandbox tables on first connection. */
  static async connect(env: ProcessEnv): Promise<SandboxStore> {
    return SandboxStore.fromSql(await openDatabase(env));
  }

  private static async fromSql(db: Sql): Promise<SandboxStore> {
    try {
      await db.exec(SCHEMA);
    } catch (error) {
      await db.close();
      throw error;
    }
    return new SandboxStore(db);
  }

  async close(): Promise<void> {
    await this.db.close();
  }

  async ensureComputer(
    agentId: string,
    provider: SandboxProviderKind,
  ): Promise<ComputerInfo & { sandboxId: string | null }> {
    await this.db.query(
      `INSERT INTO computers (agent_id, id, provider) VALUES ($1, $2, $3)
       ON CONFLICT (agent_id) DO NOTHING`,
      [agentId, crypto.randomUUID(), provider],
    );
    const existing = await this.getComputer(agentId);
    if (existing && existing.provider !== provider) {
      await this.db.query(
        `UPDATE computers SET provider = $2, sandbox_id = NULL WHERE agent_id = $1`,
        [agentId, provider],
      );
    }
    const computer = await this.getComputer(agentId);
    if (!computer) throw new Error("Failed to store the computer");
    return computer;
  }

  async countComputers(agentId: string): Promise<number> {
    const result = await this.db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM computers WHERE agent_id = $1`,
      [agentId],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async getComputer(
    agentId: string,
  ): Promise<(ComputerInfo & { sandboxId: string | null }) | null> {
    const result = await this.db.query<ComputerRow>(
      `SELECT agent_id, id, provider, sandbox_id, created_at FROM computers WHERE agent_id = $1`,
      [agentId],
    );
    const row = result.rows[0];
    return row ? mapComputer(row) : null;
  }

  async setSandboxId(agentId: string, sandboxId: string): Promise<void> {
    await this.db.query(`UPDATE computers SET sandbox_id = $2 WHERE agent_id = $1`, [
      agentId,
      sandboxId,
    ]);
  }

  async writeFile(agentId: string, path: string, content: string): Promise<void> {
    await this.db.query(
      `INSERT INTO sandbox_files (agent_id, path, content)
       VALUES ($1, $2, $3)
       ON CONFLICT (agent_id, path) DO UPDATE
       SET content = EXCLUDED.content, updated_at = NOW()`,
      [agentId, path, content],
    );
  }

  async readFile(agentId: string, path: string): Promise<string | null> {
    const result = await this.db.query<{ content: string }>(
      `SELECT content FROM sandbox_files WHERE agent_id = $1 AND path = $2`,
      [agentId, path],
    );
    return result.rows[0]?.content ?? null;
  }

  async listPaths(agentId: string): Promise<string[]> {
    const result = await this.db.query<{ path: string }>(
      `SELECT path FROM sandbox_files WHERE agent_id = $1 ORDER BY path ASC`,
      [agentId],
    );
    return result.rows.map((row) => row.path);
  }

  async insertRun(input: {
    agentId: string;
    tool: ComputerToolName;
    command: string | null;
    arguments: Record<string, string>;
    stdout: string;
    stderr: string;
    exitCode: number | null;
    timedOut: boolean;
    changedFiles: string[];
  }): Promise<SandboxRun> {
    const id = crypto.randomUUID();
    const result = await this.db.query<RunRow>(
      `INSERT INTO sandbox_runs (
         id, agent_id, tool, command, arguments, stdout, stderr, exit_code, timed_out, changed_files
       )
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10::jsonb)
       RETURNING id, agent_id, tool, command, arguments, stdout, stderr, exit_code, timed_out,
                 changed_files, created_at`,
      [
        id,
        input.agentId,
        input.tool,
        input.command,
        JSON.stringify(input.arguments),
        input.stdout,
        input.stderr,
        input.exitCode,
        input.timedOut,
        JSON.stringify(input.changedFiles),
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error("Failed to store the sandbox run");
    return mapRun(row);
  }

  async listRuns(agentId: string, limit = 40): Promise<SandboxRun[]> {
    const result = await this.db.query<RunRow>(
      `SELECT id, agent_id, tool, command, arguments, stdout, stderr, exit_code, timed_out,
              changed_files, created_at
       FROM sandbox_runs
       WHERE agent_id = $1
       ORDER BY created_at DESC, id DESC
       LIMIT $2`,
      [agentId, limit],
    );
    return result.rows.map(mapRun);
  }
}
