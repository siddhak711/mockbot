import { afterEach, expect, it } from "vitest";
import { POST } from "../app/api/chat/route";
import { buildMockReply, MockProvider, selectProvider } from "../src/llm";
import { resetAppContext, setAppContext } from "../src/context";
import { ConversationStore } from "../src/store";
import { deltas, readSse } from "./helpers";

afterEach(async () => {
  await resetAppContext();
});

it("streams a mock reply when no API key is configured", async () => {
  const provider = selectProvider({ MOCK_STREAM_DELAY_MS: "0", MOCK_CHUNK_SIZE: "16" });
  expect(provider.id).toBe("mock");
  const store = await ConversationStore.open();
  setAppContext({ store, provider });

  const response = await POST(
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Say hello" }),
    }),
  );

  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  const events = await readSse(response);
  expect(events.map((event) => event.event)).toContain("meta");
  expect(events.at(-1)?.event).toBe("done");
  expect(deltas(events)).toBe(buildMockReply("Say hello"));

  const listed = await store.listConversations();
  expect(listed).toHaveLength(1);
  expect(listed[0]?.title).toBe("Say hello");
  const loaded = await store.getConversation(listed[0]!.id);
  expect(loaded?.messages.map((message) => [message.role, message.content])).toEqual([
    ["user", "Say hello"],
    ["assistant", buildMockReply("Say hello")],
  ]);
  const raw = JSON.stringify(events);
  expect(raw).not.toContain("LLM_API_KEY");
});

it("appends a later turn to the same conversation", async () => {
  const store = await ConversationStore.open();
  setAppContext({
    store,
    provider: new MockProvider({ delayMs: 0, chunkSize: 32, reply: () => "Second reply" }),
  });
  const conversation = await store.createConversation("Existing");
  await store.addMessage(conversation.id, "user", "First");
  await store.addMessage(conversation.id, "assistant", "Earlier");

  const response = await POST(
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Next", conversationId: conversation.id }),
    }),
  );
  const events = await readSse(response);
  const meta = events.find((event) => event.event === "meta");
  expect((meta?.data as { conversationId: string }).conversationId).toBe(conversation.id);
  expect(deltas(events)).toBe("Second reply");

  const loaded = await store.getConversation(conversation.id);
  expect(loaded?.messages.map((message) => message.content)).toEqual([
    "First",
    "Earlier",
    "Next",
    "Second reply",
  ]);
});

it("rejects an empty message and an unknown conversation", async () => {
  const store = await ConversationStore.open();
  setAppContext({ store, provider: new MockProvider({ delayMs: 0 }) });

  const empty = await POST(
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "   " }),
    }),
  );
  expect(empty.status).toBe(400);

  const missing = await POST(
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Hi", conversationId: "missing" }),
    }),
  );
  expect(missing.status).toBe(404);
  expect(await store.listConversations()).toEqual([]);
});
