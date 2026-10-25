import { afterEach, expect, it } from "vitest";
import { toolActivity } from "../src/chat";
import { DEFAULT_AGENT_ID } from "../src/agent";
import { ConversationStore } from "../src/store";
import { createMemoryTools } from "../src/tools/memory";

it("labels each memory tool failure instead of calling every error a blocked write", () => {
  const forgotten = toolActivity(
    { id: "1", name: "memory_delete", output: "No memory with that key is stored.", isError: true },
    "done",
  );
  expect(forgotten.title).toBe("Could not forget that memory");
  expect(forgotten.title).not.toMatch(/write blocked/i);

  const searched = toolActivity(
    { id: "2", name: "memory_search", output: "sk-test-1234567890abcdefghij", isError: false },
    "done",
  );
  expect(searched.title).toBe("Searching memory");
  expect(searched.detail).not.toContain("sk-test");
  expect(searched.detail).not.toMatch(/not stored/i);

  const blocked = toolActivity(
    {
      id: "3",
      name: "memory_write",
      output: "Blocked. The text looks like a secret (openai_key) and was not stored.",
      isError: true,
      blocked: "secret",
    },
    "done",
  );
  expect(blocked.title).toBe("Memory write blocked");
  expect(blocked.detail).toBe("Blocked. A secret was not stored.");
  expect(blocked.detail).not.toContain("openai_key");

  const updated = toolActivity(
    { id: "4", name: "memory_update", output: "No memory with that key is stored.", isError: true },
    "done",
  );
  expect(updated.title).toBe("Could not update that memory");
});

const openStores: ConversationStore[] = [];

afterEach(async () => {
  await Promise.all(openStores.splice(0).map((store) => store.close()));
});

it("saves a memory whose key and text contain secret without labeling it blocked", async () => {
  const store = await ConversationStore.open();
  openStores.push(store);
  const text = "the secret project is named aurora and is not stored in the other notebook";
  const tools = createMemoryTools(store);
  const write = tools.find((tool) => tool.name === "memory_write");
  if (!write) throw new Error("memory_write is missing");
  const saved = await write.invoke(
    { key: "secret project", text, kind: "fact" },
    {
      memory: {
        agentId: DEFAULT_AGENT_ID,
        conversationId: "conversation",
        sourceMessageId: null,
        userMessages: [`Remember that ${text}`],
        toolOutputs: [],
      },
    },
  );
  expect(saved.isError).toBeUndefined();
  expect(saved.blocked).toBeUndefined();
  expect(saved.content).toContain("secret project");

  const activity = toolActivity(
    {
      id: "saved",
      name: "memory_write",
      output: saved.content,
      isError: false,
    },
    "done",
  );
  expect(activity.title).toBe("Saving a memory");
  expect(activity.detail).toContain("secret project");
  expect(activity.title).not.toMatch(/blocked/i);

  const live = await store.memories.listLive(DEFAULT_AGENT_ID);
  expect(live.map((memory) => [memory.key, memory.content])).toEqual([["secret project", text]]);
});
