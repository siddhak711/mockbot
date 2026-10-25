import { afterEach, expect, it, vi } from "vitest";
import { POST as createAgent } from "../app/api/agents/route";
import { POST } from "../app/api/chat/route";
import { DEFAULT_AGENT_ID } from "../src/agent";
import { resetAppContext, setAppContext } from "../src/context";
import { MockProvider, type LlmProvider } from "../src/llm";
import { sectionText } from "../src/memory/prompt";
import { ConversationStore } from "../src/store";
import type { LlmMessage, LlmStreamEvent } from "../src/types";
import { deltas, readSse } from "./helpers";

afterEach(async () => {
  await resetAppContext();
  vi.restoreAllMocks();
});

async function post(message: string, conversationId?: string, agentId?: string): Promise<Response> {
  return POST(
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, conversationId, agentId }),
    }),
  );
}

it("includes memory tool rules on the first remember turn before any memory exists", async () => {
  let system = "";
  const store = await ConversationStore.open();
  setAppContext({
    store,
    provider: new MockProvider({
      delayMs: 0,
      chunkSize: 80,
      onMessages(messages) {
        system = messages.find((message) => message.role === "system")?.content ?? system;
      },
    }),
  });

  const saved = await readSse(await post("Remember that my favorite color is blue"));
  expect(deltas(saved)).toContain("I'll remember that");
  expect(await store.memories.listLive(DEFAULT_AGENT_ID)).toHaveLength(1);
  expect(system).toContain(
    "If you need something that is not listed, call tool_search with a short query, then call the tool it returns.",
  );
  expect(system).toContain(
    "You have durable memory for this agent. Use the memory tools. Do not claim you saved something unless the tool succeeded.",
  );
  expect(system).toContain("memory_write(key, text, kind?)");
  expect(system).not.toContain("<profile-memories>");
});

it("includes memory tool rules for a custom agent", async () => {
  let system = "";
  const store = await ConversationStore.open();
  setAppContext({
    store,
    provider: new MockProvider({
      delayMs: 0,
      reply(messages) {
        system = messages.find((message) => message.role === "system")?.content ?? "";
        return "ok";
      },
    }),
  });
  const created = await createAgent(
    new Request("http://localhost/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Researcher",
        instructions: "You study groves and answer in one sentence.",
      }),
    }),
  );
  expect(created.status).toBe(201);
  const agentId = ((await created.json()) as { agent: { id: string } }).agent.id;
  await store.memories.write({
    agentId,
    key: "grove code",
    content: "the grove code is 42",
    kind: "profile",
    createdBy: "user",
  });

  const events = await readSse(await post("What is the grove code?", undefined, agentId));
  expect(deltas(events)).toBe("ok");
  expect(system).toContain("You study groves and answer in one sentence.");
  expect(system).toContain("memory_write(key, text, kind?)");
  expect(system).toContain(
    "Tools that send, post, delete, pay, or invite someone wait until the person approves them.",
  );
  expect(sectionText(system, "profile-memories")).toContain("42");
});

it("shows a remembered fact in the next conversation's system prompt trace", async () => {
  const prompts: LlmMessage[][] = [];
  const store = await ConversationStore.open();
  setAppContext({
    store,
    provider: new MockProvider({
      delayMs: 0,
      chunkSize: 80,
      onMessages(messages) {
        prompts.push(messages.map((message) => ({ ...message })));
      },
    }),
  });

  const saved = await readSse(await post("Remember that my favorite color is blue"));
  expect(deltas(saved)).toContain("I'll remember that");
  const live = await store.memories.listLive(DEFAULT_AGENT_ID);
  expect(live.map((memory) => [memory.kind, memory.key, memory.content])).toEqual([
    ["profile", "favorite color", "my favorite color is blue"],
  ]);

  const recalled = await readSse(await post("What is my favorite color?"));
  expect(deltas(recalled)).toContain("blue");
  const questionPrompt = prompts.find((messages) =>
    messages.some(
      (message) => message.role === "user" && message.content === "What is my favorite color?",
    ),
  );
  expect(questionPrompt).toBeTruthy();
  const system = questionPrompt!
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n");
  const users = questionPrompt!
    .filter((message) => message.role === "user")
    .map((message) => message.content);
  expect(sectionText(system, "profile-memories")).toContain("blue");
  expect(users).toEqual(["What is my favorite color?"]);
  expect(users.join("\n")).not.toContain("profile-memories");
  expect(users.join("\n")).not.toContain("my favorite color is blue");
});

it("does not retrieve a deleted memory or a different agent's memory", async () => {
  const prompts: LlmMessage[][] = [];
  const store = await ConversationStore.open();
  await store.memories.write({
    agentId: DEFAULT_AGENT_ID,
    key: "lane",
    content: "zephyr-lane",
    kind: "profile",
    createdBy: "user",
  });
  await store.memories.softDeleteByKey(DEFAULT_AGENT_ID, "lane");
  await store.memories.write({
    agentId: "other-agent",
    key: "city",
    content: "Atlantis harbor",
    kind: "profile",
    createdBy: "user",
  });
  setAppContext({
    store,
    provider: new MockProvider({
      delayMs: 0,
      chunkSize: 80,
      onMessages(messages) {
        prompts.push(messages.map((message) => ({ ...message })));
      },
    }),
  });

  const events = await readSse(await post("What is my lane?"));
  expect(deltas(events)).not.toContain("zephyr-lane");
  expect(deltas(events)).not.toContain("Atlantis");
  const system = prompts
    .flat()
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n");
  expect(system).not.toContain("zephyr-lane");
  expect(system).not.toContain("Atlantis");
});

it("does not store a planted API key from the remember path", async () => {
  const secret = "sk-test-1234567890abcdefghij";
  const warnings: string[] = [];
  vi.spyOn(console, "warn").mockImplementation((message) => {
    warnings.push(String(message));
  });
  const store = await ConversationStore.open();
  setAppContext({ store, provider: new MockProvider({ delayMs: 0, chunkSize: 40 }) });

  const events = await readSse(await post(`Remember that my API key is ${secret}`));
  expect(deltas(events)).toMatch(/did not save/i);
  expect(deltas(events)).not.toContain(secret);
  expect(JSON.stringify(await store.memories.listForAgent(DEFAULT_AGENT_ID))).not.toContain(secret);
  expect(warnings.join("\n")).toContain("memory_write_blocked");
  expect(warnings.join("\n")).not.toContain(secret);
});

it("stops the tool loop at the step cap", async () => {
  const store = await ConversationStore.open();
  const provider: LlmProvider = {
    id: "mock",
    model: null,
    async *stream(): AsyncIterable<LlmStreamEvent> {
      yield {
        type: "tool_call",
        index: 0,
        id: `call_${crypto.randomUUID()}`,
        name: "memory_search",
        arguments: JSON.stringify({ query: "zzzz-no-such-memory" }),
      };
      yield { type: "end", finishReason: "tool_calls" };
    },
  };
  setAppContext({ store, provider });
  const events = await readSse(await post("Search forever"));
  expect(events.at(-1)?.event).toBe("done");
  expect(events.filter((event) => event.event === "tool_start").length).toBeGreaterThan(0);
  expect(events.filter((event) => event.event === "tool_start").length).toBeLessThanOrEqual(8);
});
