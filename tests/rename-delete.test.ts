import { afterEach, expect, it } from "vitest";
import { GET as listConversations } from "../app/api/conversations/route";
import { DELETE, GET as readConversation, PATCH } from "../app/api/conversations/[id]/route";
import { resetAppContext, setAppContext } from "../src/context";
import { MockProvider } from "../src/llm";
import { ConversationStore } from "../src/store";

const params = (id: string) => ({ params: Promise.resolve({ id }) });

afterEach(async () => {
  await resetAppContext();
});

it("rename and delete update the list and the stored thread", async () => {
  const store = await ConversationStore.open();
  setAppContext({ store, provider: new MockProvider({ delayMs: 0 }) });
  const open = await store.createConversation("Open thread");
  await store.addMessage(open.id, "user", "Keep me");
  await store.addMessage(open.id, "assistant", "Still here");
  const other = await store.createConversation("Other");

  const renamed = await PATCH(
    new Request("http://localhost/api/conversations/" + open.id, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Renamed thread" }),
    }),
    params(open.id),
  );
  expect(renamed.status).toBe(200);

  const list = (await (await listConversations()).json()) as {
    conversations: Array<{ id: string; title: string }>;
  };
  expect(list.conversations.map((item) => item.title).sort()).toEqual(["Other", "Renamed thread"]);

  const thread = (await (
    await readConversation(new Request("http://localhost"), params(open.id))
  ).json()) as {
    conversation: { title: string };
    messages: Array<{ content: string }>;
  };
  expect(thread.conversation.title).toBe("Renamed thread");
  expect(thread.messages.map((message) => message.content)).toEqual(["Keep me", "Still here"]);

  const removed = await DELETE(new Request("http://localhost"), params(open.id));
  expect(removed.status).toBe(204);

  const afterDelete = (await (await listConversations()).json()) as {
    conversations: Array<{ id: string; title: string }>;
  };
  expect(afterDelete.conversations.map((item) => item.id)).toEqual([other.id]);
  const missing = await readConversation(new Request("http://localhost"), params(open.id));
  expect(missing.status).toBe(404);
});

it("rejects an empty rename and a missing delete", async () => {
  const store = await ConversationStore.open();
  setAppContext({ store, provider: new MockProvider({ delayMs: 0 }) });
  const conversation = await store.createConversation("Title");

  const empty = await PATCH(
    new Request("http://localhost", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "  " }),
    }),
    params(conversation.id),
  );
  expect(empty.status).toBe(400);
  expect((await store.getConversation(conversation.id))?.conversation.title).toBe("Title");

  const missing = await DELETE(new Request("http://localhost"), params("missing"));
  expect(missing.status).toBe(404);
});
