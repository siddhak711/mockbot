import { afterEach, expect, it } from "vitest";
import { GET } from "../app/api/memories/route";
import { DELETE, PATCH } from "../app/api/memories/[id]/route";
import { DEFAULT_AGENT_ID } from "../src/agent";
import { resetAppContext, setAppContext } from "../src/context";
import { MockProvider } from "../src/llm";
import { ConversationStore } from "../src/store";
import type { Memory } from "../src/types";

const params = (id: string) => ({ params: Promise.resolve({ id }) });

afterEach(async () => {
  await resetAppContext();
});

it("lists, edits, and deletes memories for this agent only", async () => {
  const store = await ConversationStore.open();
  setAppContext({ store, provider: new MockProvider({ delayMs: 0 }) });
  const conversation = await store.createConversation("Source");
  const message = await store.addMessage(
    conversation.id,
    "user",
    "Remember that my city is Lisbon",
  );
  const written = await store.memories.write({
    agentId: DEFAULT_AGENT_ID,
    key: "city",
    content: "my city is Lisbon",
    kind: "profile",
    sourceMessageId: message.id,
    createdBy: "model",
  });
  await store.memories.write({
    agentId: "other-agent",
    key: "city",
    content: "Atlantis harbor",
    kind: "profile",
    createdBy: "user",
  });

  const listed = (await (await GET()).json()) as { memories: Memory[] };
  expect(listed.memories.map((memory) => memory.content)).toEqual(["my city is Lisbon"]);
  expect(listed.memories[0]?.sourceSnippet).toContain("Lisbon");
  expect(JSON.stringify(listed)).not.toContain("Atlantis");

  const edited = await PATCH(
    new Request("http://localhost/api/memories/" + written.memory.id, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "my city is Porto", kind: "profile" }),
    }),
    params(written.memory.id),
  );
  expect(edited.status).toBe(200);
  const afterEdit = (await (await GET()).json()) as { memories: Memory[] };
  expect(afterEdit.memories.map((memory) => memory.content)).toEqual(["my city is Porto"]);
  expect(afterEdit.memories[0]?.history.map((version) => version.content)).toContain(
    "my city is Lisbon",
  );

  const secret = await PATCH(
    new Request("http://localhost/api/memories/" + afterEdit.memories[0]!.id, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "sk-test-1234567890abcdefghij" }),
    }),
    params(afterEdit.memories[0]!.id),
  );
  expect(secret.status).toBe(400);
  expect(await secret.text()).not.toContain("sk-test");
  const still = await store.memories.listLive(DEFAULT_AGENT_ID);
  expect(still.map((memory) => memory.content)).toEqual(["my city is Porto"]);

  const removed = await DELETE(new Request("http://localhost"), params(still[0]!.id));
  expect(removed.status).toBe(204);
  const afterDelete = (await (await GET()).json()) as { memories: Memory[] };
  expect(afterDelete.memories).toEqual([]);
  expect(await store.memories.search({ agentId: DEFAULT_AGENT_ID, query: "Porto" })).toEqual([]);
});
