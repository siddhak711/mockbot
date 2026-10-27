import { MIGRATIONS, type Migration } from "./migrations";
import type { Sql } from "./sql";

/**
 * Advisory lock key held while migrating. Concurrent cold starts queue on it,
 * so only one of them runs a pending migration and the rest see it recorded.
 */
export const MIGRATION_LOCK_KEY = 7_315_052_026;

const LEDGER = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

async function lock(tx: Sql): Promise<void> {
  await tx.query("SELECT pg_advisory_xact_lock($1::bigint)", [MIGRATION_LOCK_KEY]);
}

/**
 * Run one migration and its ledger row in one transaction, behind the lock.
 * A failure rolls back both, so a half-applied migration is never left
 * unrecorded. The ledger is read again under the lock, because another
 * process may have applied it while this one waited.
 */
async function applyOne(db: Sql, migration: Migration): Promise<void> {
  await db.transaction(async (tx) => {
    await lock(tx);
    const done = await tx.query("SELECT 1 FROM schema_migrations WHERE id = $1", [migration.id]);
    if (done.rows.length > 0) return;
    await tx.exec(migration.sql);
    await tx.query("INSERT INTO schema_migrations (id) VALUES ($1)", [migration.id]);
  });
}

export async function migrate(
  db: Sql,
  migrations: readonly Migration[] = MIGRATIONS,
): Promise<void> {
  const have = await db.transaction(async (tx) => {
    await lock(tx);
    await tx.exec(LEDGER);
    const applied = await tx.query<{ id: string }>("SELECT id FROM schema_migrations");
    return new Set(applied.rows.map((row) => row.id));
  });
  for (const migration of migrations) {
    if (have.has(migration.id)) continue;
    await applyOne(db, migration);
  }
}
