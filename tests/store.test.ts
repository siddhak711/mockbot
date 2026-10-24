import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ConversationStore } from "../src/store";

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

it("renames and deletes a conversation", async () => {
  const store = await openStore();
  const kept = await store.createConversation("Keep");
  const doomed = await store.createConversation("Remove me");
  await store.addMessage(doomed.id, "user", "bye");

  const renamed = await store.renameConversation(kept.id, "Renamed");
  expect(renamed?.title).toBe("Renamed");
  expect(await store.deleteConversation(doomed.id)).toBe(true);

  const listed = await store.listConversations();
  expect(listed.map((item) => item.id)).toEqual([kept.id]);
  expect(listed[0]?.title).toBe("Renamed");
  expect(await store.getConversation(doomed.id)).toBeNull();
  expect(await store.renameConversation("missing", "Nope")).toBeNull();
  expect(await store.deleteConversation("missing")).toBe(false);
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
