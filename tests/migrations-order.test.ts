import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { MIGRATIONS } from "../src/db/migrations";
import { migrate } from "../src/db/migrate";
import { openPglite } from "../src/db/pglite";

const PLAN_STATUSES = ["running", "approval", "ask", "plan", "done", "denied", "error"];

it("applies every migration in order on a fresh database", async () => {
  const ids = MIGRATIONS.map((migration) => migration.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids.at(-1)).toBe("012_plan_mode");

  const dir = await mkdtemp(join(tmpdir(), "mockbot-migrations-"));
  const db = await openPglite(dir);
  try {
    await migrate(db);
    const applied = await db.query<{ id: string }>(
      "SELECT id FROM schema_migrations ORDER BY applied_at ASC, id ASC",
    );
    expect(applied.rows.map((row) => row.id)).toEqual(ids);

    const constraint = await db.query<{ definition: string }>(
      "SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname = 'tool_calls_status_check'",
    );
    const definition = constraint.rows[0]?.definition ?? "";
    for (const status of PLAN_STATUSES) {
      expect(definition).toContain(`'${status}'`);
    }

    await db.query(
      `INSERT INTO conversations (id, title) VALUES ('conv_plan', 'plan')`,
    );
    await db.query(
      `INSERT INTO messages (id, conversation_id, role, content) VALUES ('msg_plan', 'conv_plan', 'assistant', '')`,
    );
    await db.query(
      `INSERT INTO tool_calls (id, conversation_id, message_id, name, arguments, status)
       VALUES ('tool_plan', 'conv_plan', 'msg_plan', 'propose_plan', '{}', 'plan')`,
    );
    await expect(
      db.query(
        `INSERT INTO tool_calls (id, conversation_id, message_id, name, arguments, status)
         VALUES ('tool_bad', 'conv_plan', 'msg_plan', 'propose_plan', '{}', 'waiting')`,
      ),
    ).rejects.toThrow(/tool_calls_status_check/);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
