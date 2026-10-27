import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, expect, it } from "vitest";
import { ConversationStore } from "../src/store";
import { emptyTrace } from "../src/trace";

const openStores: ConversationStore[] = [];

afterEach(async () => {
  await Promise.all(openStores.splice(0).map((store) => store.close()));
});

async function openStore(dataDir?: string): Promise<ConversationStore> {
  const store = await ConversationStore.open(dataDir);
  openStores.push(store);
  return store;
}

it("stores a conversation, its title, and every message", async () => {
  const store = await openStore();
  const conversation = await store.createConversation("First chat");
  await store.addMessage(conversation.id, "user", "Hello");
  await store.addMessage(conversation.id, "assistant", "Hi there");

  const listed = await store.listConversations();
  expect(listed.map((item) => item.title)).toEqual(["First chat"]);

  const loaded = await store.getConversation(conversation.id);
  expect(loaded?.messages.map((message) => [message.role, message.content])).toEqual([
    ["user", "Hello"],
    ["assistant", "Hi there"],
  ]);
});

it("returns the same conversation id for the same agent", async () => {
  const store = await openStore();
  const first = await store.getOrCreateAgentConversation("agent_default", null);
  const second = await store.getOrCreateAgentConversation("agent_default", null);
  expect(second.id).toBe(first.id);

  await store.connection.query(
    `INSERT INTO users (id, email) VALUES ('user_a', 'a@example.com'), ('user_b', 'b@example.com')`,
  );
  const ada = await store.getOrCreateAgentConversation("agent_default", "user_a");
  const adaAgain = await store.getOrCreateAgentConversation("agent_default", "user_a");
  const bea = await store.getOrCreateAgentConversation("agent_default", "user_b");
  const other = await store.getOrCreateAgentConversation("agent_other", "user_a");
  expect(adaAgain.id).toBe(ada.id);
  expect(bea.id).not.toBe(ada.id);
  expect(other.id).not.toBe(ada.id);
  expect(ada.id).not.toBe(first.id);
  await expect(store.createConversation("Another", "agent_default", "user_a")).rejects.toThrow();
});

it("stores and reloads a stream trace", async () => {
  const store = await openStore();
  const conversation = await store.createConversation("Traced");
  const trace = {
    ...emptyTrace(),
    started: true,
    role: "assistant" as const,
    reasoning: "Looking it up",
    tools: [
      {
        index: 0,
        id: "call_lookup",
        name: "lookup_context",
        arguments: '{"query":"Hi"}',
        result: "Local context only.",
      },
    ],
    text: "Done",
    finishReason: "stop",
    ended: true,
  };
  await store.addMessage(conversation.id, "user", "Hi");
  const assistant = await store.addMessage(conversation.id, "assistant", "Done", trace);
  await store.updateMessage(assistant.id, "Done.", {
    ...trace,
    text: "Done.",
    reasoning: "Looking it up.",
  });

  const loaded = await store.getConversation(conversation.id);
  expect(loaded?.messages.map((message) => message.trace)).toEqual([
    null,
    { ...trace, text: "Done.", reasoning: "Looking it up." },
  ]);
  expect(loaded?.messages[1]?.content).toBe("Done.");
});

it("adds a trace column when opening a database created before traces", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mockbot-trace-"));
  try {
    const prep = new PGlite(dir);
    await prep.exec(`
      CREATE TABLE conversations (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE messages (
        seq BIGSERIAL PRIMARY KEY,
        id TEXT NOT NULL UNIQUE,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
        content TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await prep.close();

    const store = await openStore(dir);
    const conversation = await store.createConversation("Migrated");
    await store.addMessage(conversation.id, "assistant", "Hi", {
      ...emptyTrace(),
      started: true,
      role: "assistant",
      reasoning: "kept",
      text: "Hi",
      ended: true,
      finishReason: "stop",
    });
    await store.close();

    const again = await openStore(dir);
    const loaded = await again.getConversation(conversation.id);
    expect(loaded?.messages[0]?.content).toBe("Hi");
    expect(loaded?.messages[0]?.trace?.reasoning).toBe("kept");
    expect(loaded?.messages[0]?.trace?.finishReason).toBe("stop");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("restores titles and messages from the same embedded database", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mockbot-"));
  try {
    const first = await ConversationStore.open(dir);
    const conversation = await first.createConversation("Persisted");
    await first.addMessage(conversation.id, "user", "Remember this");
    await first.addMessage(conversation.id, "assistant", "Stored");
    await first.close();

    const second = await openStore(dir);
    const listed = await second.listConversations();
    expect(listed.map((item) => item.title)).toEqual(["Persisted"]);
    const loaded = await second.getConversation(conversation.id);
    expect(loaded?.messages.map((message) => message.content)).toEqual(["Remember this", "Stored"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
