import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PGlite } from "@electric-sql/pglite";

const MIGRATION_TABLE = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

// Literal URLs so the server bundle traces these files next to this module.
const BUNDLED_MIGRATIONS = [
  new URL("./migrations/001_workspace.sql", import.meta.url),
  new URL("./migrations/002_connectors.sql", import.meta.url),
] as const;

export function migrationDir(): string {
  return dirname(fileURLToPath(BUNDLED_MIGRATIONS[0]));
}

// Stable ids only. A production bundle may also emit hashed copies such as
// 001_workspace.<hash>.sql, and those must not become migration ids.
const MIGRATION_FILE = /^\d{3}_[a-z0-9_]+\.sql$/;

function migrationsFromDir(dir: string): { id: string; sql: string }[] {
  return readdirSync(dir)
    .filter((name) => MIGRATION_FILE.test(name))
    .sort()
    .map((name) => ({
      id: name.replace(/\.sql$/, ""),
      sql: readFileSync(join(dir, name), "utf8"),
    }));
}

function bundledMigrations(): { id: string; sql: string }[] {
  return [
    {
      id: "001_workspace",
      sql: readFileSync(new URL("./migrations/001_workspace.sql", import.meta.url), "utf8"),
    },
    {
      id: "002_connectors",
      sql: readFileSync(new URL("./migrations/002_connectors.sql", import.meta.url), "utf8"),
    },
  ];
}

export function readMigrations(dir = migrationDir()): { id: string; sql: string }[] {
  if (existsSync(dir)) {
    const found = migrationsFromDir(dir);
    if (found.length > 0) return found;
  }
  const fromProject = join(process.cwd(), "src/db/migrations");
  if (fromProject !== dir && existsSync(fromProject)) {
    const found = migrationsFromDir(fromProject);
    if (found.length > 0) return found;
  }
  return bundledMigrations();
}

export async function applyMigrations(db: PGlite, dir = migrationDir()): Promise<string[]> {
  await db.exec(MIGRATION_TABLE);
  const applied: string[] = [];
  for (const migration of readMigrations(dir)) {
    const existing = await db.query<{ id: string }>(
      `SELECT id FROM schema_migrations WHERE id = $1`,
      [migration.id],
    );
    if (existing.rows.length > 0) continue;
    await db.exec("BEGIN");
    try {
      await db.exec(migration.sql);
      await db.query(`INSERT INTO schema_migrations (id) VALUES ($1)`, [migration.id]);
      await db.exec("COMMIT");
    } catch (error) {
      await db.exec("ROLLBACK");
      throw error;
    }
    applied.push(migration.id);
  }
  return applied;
}
