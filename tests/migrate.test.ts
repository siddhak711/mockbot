import { afterEach, expect, it } from "vitest";
import { MIGRATION_LOCK_KEY, migrate } from "../src/db/migrate";
import { MIGRATIONS } from "../src/db/migrations";
import { openNeon, type NeonSession } from "../src/db/neon";
import { openPglite } from "../src/db/pglite";
import type { Sql } from "../src/db/sql";

const open: Sql[] = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map((db) => db.close()));
});

async function pglite(): Promise<Sql> {
  const db = await openPglite();
  open.push(db);
  return db;
}

async function ledger(db: Sql): Promise<string[]> {
  const result = await db.query<{ id: string }>("SELECT id FROM schema_migrations ORDER BY id");
  return result.rows.map((row) => row.id);
}

it("rolls back a migration that fails partway and leaves it unrecorded", async () => {
  const db = await pglite();
  const migrations = [
    { id: "001_ok", sql: "CREATE TABLE kept (id INT);" },
    {
      id: "002_broken",
      sql: `
CREATE TABLE half (id INT);
INSERT INTO kept (id) VALUES (1);
SELECT * FROM missing_table;
`,
    },
  ];

  await expect(migrate(db, migrations)).rejects.toThrow(/missing_table/);
  expect(await ledger(db)).toEqual(["001_ok"]);
  const half = await db.query<{ name: string | null }>("SELECT to_regclass('half') AS name");
  expect(half.rows[0]?.name).toBeNull();
  expect((await db.query("SELECT id FROM kept")).rows).toEqual([]);

  migrations[1] = { id: "002_broken", sql: "CREATE TABLE half (id INT);" };
  await migrate(db, migrations);
  expect(await ledger(db)).toEqual(["001_ok", "002_broken"]);
});

it("applies each migration once when two cold starts migrate together", async () => {
  const db = await pglite();
  const migrations = [
    { id: "001_hits", sql: "CREATE TABLE hits (n INT); INSERT INTO hits (n) VALUES (1);" },
    { id: "002_more", sql: "INSERT INTO hits (n) VALUES (2);" },
  ];
  await Promise.all([migrate(db, migrations), migrate(db, migrations), migrate(db, migrations)]);
  const hits = await db.query<{ n: number }>("SELECT n FROM hits ORDER BY n");
  expect(hits.rows.map((row) => row.n)).toEqual([1, 2]);
  expect(await ledger(db)).toEqual(["001_hits", "002_more"]);
});

it("records 015 on a database whose routines tables came from the old attach path", async () => {
  const db = await pglite();
  const tracked = MIGRATIONS.filter((item) => item.id !== "015_agent_grants_and_routines");
  const consolidated = MIGRATIONS.find((item) => item.id === "015_agent_grants_and_routines");
  expect(consolidated).toBeDefined();
  await migrate(db, tracked);
  // Before 015, attach created these tables on every cold start, untracked.
  await db.exec(consolidated!.sql);
  await db.query(
    `INSERT INTO routines (id, name, prompt, trigger_kind, event_name)
     VALUES ('kept', 'Kept', 'Stay', 'event', 'shipped')`,
  );

  await migrate(db);
  expect(await ledger(db)).toContain("015_agent_grants_and_routines");
  const kept = await db.query<{ id: string }>("SELECT id FROM routines");
  expect(kept.rows).toEqual([{ id: "kept" }]);
});

it("runs each Neon migration and its ledger row on one locked session", async () => {
  const log: string[] = [];
  let sessions = 0;
  const db = openNeon("postgres://user:pass@localhost/db", {
    pool: {
      async connect(): Promise<NeonSession> {
        sessions += 1;
        return {
          async query(text: string, params?: readonly unknown[]) {
            const line = text.trim().split("\n")[0] ?? "";
            log.push(params?.length ? `${line} ${JSON.stringify(params)}` : line);
            if (text.includes("boom")) throw new Error("boom");
            return { rows: [] };
          },
          release() {},
        };
      },
      async end() {},
    },
  });

  await expect(
    migrate(db, [
      { id: "001_a", sql: "CREATE TABLE a (id INT);" },
      { id: "002_b", sql: "CREATE TABLE b (id INT); SELECT boom;" },
    ]),
  ).rejects.toThrow("boom");

  const lock = `SELECT pg_advisory_xact_lock($1::bigint) [${MIGRATION_LOCK_KEY}]`;
  expect(sessions).toBe(3);
  expect(log).toEqual([
    "BEGIN",
    lock,
    "CREATE TABLE IF NOT EXISTS schema_migrations (",
    "SELECT id FROM schema_migrations",
    "COMMIT",
    "BEGIN",
    lock,
    'SELECT 1 FROM schema_migrations WHERE id = $1 ["001_a"]',
    "CREATE TABLE a (id INT)",
    'INSERT INTO schema_migrations (id) VALUES ($1) ["001_a"]',
    "COMMIT",
    "BEGIN",
    lock,
    'SELECT 1 FROM schema_migrations WHERE id = $1 ["002_b"]',
    "CREATE TABLE b (id INT)",
    "SELECT boom",
    "ROLLBACK",
  ]);
  await db.close();
});
