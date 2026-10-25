import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PGlite } from "@electric-sql/pglite";

const MIGRATION_TABLE = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

export function migrationDir(): string {
  return join(process.cwd(), "src/db/migrations");
}

export function readMigrations(dir = migrationDir()): { id: string; sql: string }[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => ({
      id: name.replace(/\.sql$/, ""),
      sql: readFileSync(join(dir, name), "utf8"),
    }));
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
