import { MIGRATIONS } from "./migrations";
import type { Sql } from "./sql";

export async function migrate(db: Sql): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  const applied = await db.query<{ id: string }>("SELECT id FROM schema_migrations");
  const have = new Set(applied.rows.map((row) => row.id));
  for (const migration of MIGRATIONS) {
    if (have.has(migration.id)) continue;
    await db.exec(migration.sql);
    await db.query("INSERT INTO schema_migrations (id) VALUES ($1) ON CONFLICT (id) DO NOTHING", [
      migration.id,
    ]);
  }
}
