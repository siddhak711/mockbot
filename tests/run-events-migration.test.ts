import { expect, it } from "vitest";
import { MIGRATIONS } from "../src/db/migrations";
import { openPglite } from "../src/db/pglite";

/** The preview migration that already ran on production, before this id moved to 011. */
const OLD_007_RUN_EVENTS = `
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
`;

it("applies 011_run_events after the stray 007_run_events table already exists", async () => {
  const migration = MIGRATIONS.find((item) => item.id === "011_run_events");
  expect(migration?.sql).toContain("CREATE TABLE IF NOT EXISTS run_events");
  expect(migration?.sql).toContain("CREATE UNIQUE INDEX IF NOT EXISTS run_events_pkey");
  expect(migration?.sql).toContain("ADD COLUMN IF NOT EXISTS");

  const db = await openPglite();
  try {
    await db.exec(`
      CREATE TABLE schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await db.exec(OLD_007_RUN_EVENTS);
    await db.query(`INSERT INTO schema_migrations (id) VALUES ('007_run_events')`);
    await db.query(
      `INSERT INTO run_events (run_id, seq, type, input, output, tokens, cost_usd, ms)
       VALUES ('run_old', 1, 'event', '{"name":"run.started"}', NULL, NULL, NULL, NULL)`,
    );

    await db.exec(migration?.sql ?? "");
    await db.exec(migration?.sql ?? "");

    const columns = await db.query<{ column_name: string; data_type: string; is_nullable: string }>(
      `SELECT column_name, data_type, is_nullable
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'run_events'
       ORDER BY ordinal_position`,
    );
    expect(columns.rows).toEqual([
      { column_name: "run_id", data_type: "text", is_nullable: "NO" },
      { column_name: "seq", data_type: "integer", is_nullable: "NO" },
      { column_name: "type", data_type: "text", is_nullable: "NO" },
      { column_name: "input", data_type: "text", is_nullable: "YES" },
      { column_name: "output", data_type: "text", is_nullable: "YES" },
      { column_name: "tokens", data_type: "integer", is_nullable: "YES" },
      { column_name: "cost_usd", data_type: "double precision", is_nullable: "YES" },
      { column_name: "ms", data_type: "integer", is_nullable: "YES" },
    ]);

    const constraints = await db.query<{ conname: string; def: string }>(
      `SELECT conname, pg_get_constraintdef(oid) AS def
       FROM pg_constraint
       WHERE conrelid = 'public.run_events'::regclass AND contype IN ('p', 'c')
       ORDER BY conname`,
    );
    expect(constraints.rows).toEqual([
      {
        conname: "run_events_pkey",
        def: "PRIMARY KEY (run_id, seq)",
      },
      {
        conname: "run_events_type_check",
        def: "CHECK ((type = ANY (ARRAY['model'::text, 'tool'::text, 'event'::text, 'error'::text])))",
      },
    ]);

    const indexes = await db.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'run_events' ORDER BY indexname`,
    );
    expect(indexes.rows.map((row) => row.indexname)).toEqual(["run_events_pkey"]);

    const stray = await db.query<{ id: string }>(
      `SELECT id FROM schema_migrations WHERE id = '007_run_events'`,
    );
    expect(stray.rows).toEqual([]);

    const stored = await db.query<{ run_id: string; seq: number; type: string }>(
      `SELECT run_id, seq, type FROM run_events ORDER BY seq`,
    );
    expect(stored.rows).toEqual([{ run_id: "run_old", seq: 1, type: "event" }]);
  } finally {
    await db.close();
  }
});
