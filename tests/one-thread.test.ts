import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { MIGRATIONS } from "../src/db/migrations";
import { splitSql } from "../src/db/sql";
import { RoutineStore } from "../src/routines/store";
import { ConversationStore } from "../src/store";

it("keeps the routine repoint inside one SQL statement", () => {
  const migration = MIGRATIONS.find((item) => item.id === "007_one_thread_per_agent");
  expect(migration).toBeTruthy();
  const parts = splitSql(migration?.sql ?? "");
  const routine = parts.find((part) => part.includes("routine_runs"));
  expect(routine?.startsWith("DO")).toBe(true);
  expect(routine).toContain("END $$");
  expect(parts.filter((part) => part.includes("END $$"))).toHaveLength(1);
});

it("merges one user's agent threads in created_at order without dropping rows", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mockbot-one-thread-"));
  const store = await ConversationStore.open(dir);
  await RoutineStore.attach(store);
  await store.connection.exec(`
    DROP INDEX IF EXISTS conversations_user_agent_key;
    DELETE FROM schema_migrations WHERE id = '007_one_thread_per_agent';
    INSERT INTO users (id, email) VALUES ('user_a', 'a@example.com');
    INSERT INTO conversations (id, title, agent_id, user_id, created_at, updated_at) VALUES
      ('old', 'Oldest', 'agent_default', NULL, '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z'),
      ('new', 'Newer', 'agent_default', NULL, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z'),
      ('empty', 'Empty', 'agent_default', NULL, '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z'),
      ('other-agent', 'Other agent', 'agent_other', NULL, '2021-01-01T00:00:00Z', '2021-01-01T00:00:00Z'),
      ('other-user', 'Other user', 'agent_default', 'user_a', '2022-01-01T00:00:00Z', '2022-01-01T00:00:00Z');
    INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES
      ('m-new', 'new', 'user', 'second', '2024-06-02T00:00:00Z'),
      ('m-old', 'old', 'user', 'first', '2020-06-01T00:00:00Z');
    INSERT INTO tool_calls (
      id, conversation_id, message_id, name, arguments, status, output, created_at
    ) VALUES
      ('t-new', 'new', 'm-new', 'lookup', '{}', 'done', 'new-out', '2024-06-02T00:00:00Z'),
      ('t-old', 'old', 'm-old', 'lookup', '{}', 'done', 'old-out', '2020-06-01T00:00:00Z');
    INSERT INTO conversation_summaries (conversation_id, summary, upto_msg, updated_at) VALUES
      ('new', 'newer summary', 'm-new', '2024-07-01T00:00:00Z'),
      ('old', 'older summary', 'm-old', '2020-07-01T00:00:00Z');
    INSERT INTO routine_events (id, name, payload) VALUES ('evt', 'shipped', 'v1');
    INSERT INTO routines (
      id, name, prompt, trigger_kind, event_name, status, conversation_id
    ) VALUES (
      'routine-new', 'Ship', 'note', 'event', 'shipped', 'active', 'new'
    );
    INSERT INTO routine_runs (
      id, routine_id, status, source, event_id, scheduled_for, conversation_id
    ) VALUES (
      'run-new', 'routine-new', 'succeeded', 'event', 'evt', '2024-01-01T00:00:00Z', 'new'
    );
  `);
  await store.close();

  try {
    const migrated = await ConversationStore.open(dir);
    const loaded = await migrated.getConversation("old");
    expect(loaded?.conversation.title).toBe("Oldest");
    expect(loaded?.messages.map((message) => message.content)).toEqual(["first", "second"]);
    expect(loaded?.messages.map((message) => message.tools?.map((tool) => tool.output))).toEqual([
      ["old-out"],
      ["new-out"],
    ]);

    const summary = await migrated.connection.query<{ summary: string; upto_msg: string }>(
      `SELECT summary, upto_msg FROM conversation_summaries WHERE conversation_id = 'old'`,
    );
    expect(summary.rows).toEqual([
      { summary: "older summary\n\nnewer summary", upto_msg: "m-new" },
    ]);
    const summaries = await migrated.connection.query<{ conversation_id: string }>(
      `SELECT conversation_id FROM conversation_summaries ORDER BY conversation_id`,
    );
    expect(summaries.rows.map((row) => row.conversation_id)).toEqual(["old"]);

    const routines = await migrated.connection.query<{ id: string; conversation_id: string }>(
      `SELECT id, conversation_id FROM routines ORDER BY id`,
    );
    expect(routines.rows).toEqual([{ id: "routine-new", conversation_id: "old" }]);
    const runs = await migrated.connection.query<{ conversation_id: string }>(
      `SELECT conversation_id FROM routine_runs`,
    );
    expect(runs.rows).toEqual([{ conversation_id: "old" }]);

    const threads = await migrated.connection.query<{
      id: string;
      agent_id: string;
      user_id: string | null;
    }>(`SELECT id, agent_id, user_id FROM conversations ORDER BY created_at ASC, id ASC`);
    expect(threads.rows).toEqual([
      { id: "old", agent_id: "agent_default", user_id: null },
      { id: "other-agent", agent_id: "agent_other", user_id: null },
      { id: "other-user", agent_id: "agent_default", user_id: "user_a" },
    ]);
    await expect(
      migrated.connection.query(
        `INSERT INTO conversations (id, title, agent_id, user_id) VALUES ('again', 'Again', 'agent_default', NULL)`,
      ),
    ).rejects.toThrow();

    await migrated.connection.exec(`
      DELETE FROM schema_migrations WHERE id = '007_one_thread_per_agent';
      DROP INDEX IF EXISTS conversations_user_agent_key;
    `);
    await migrated.close();

    const again = await ConversationStore.open(dir);
    const summaryAgain = await again.connection.query<{ summary: string }>(
      `SELECT summary FROM conversation_summaries WHERE conversation_id = 'old'`,
    );
    expect(summaryAgain.rows[0]?.summary).toBe("older summary\n\nnewer summary");
    const reloaded = await again.getConversation("old");
    expect(reloaded?.messages.map((message) => message.content)).toEqual(["first", "second"]);
    await again.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
