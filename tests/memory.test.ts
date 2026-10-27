import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { DEFAULT_AGENT_ID } from "../src/agent";
import { openDatabase } from "../src/db/open";
import { findSecrets } from "../src/memory/scrub";
import { buildSystemPrompt, sectionText } from "../src/memory/prompt";
import { estimateTokens, PROFILE_TOKEN_BUDGET } from "../src/memory/tokens";
import { ConversationStore } from "../src/store";
import { createMemoryTools } from "../src/tools/memory";
import { buildModelInput } from "../src/turn";
import { seedConversation } from "./helpers";

const openStores: ConversationStore[] = [];

afterEach(async () => {
  await Promise.all(openStores.splice(0).map((store) => store.close()));
});

async function openStore(): Promise<ConversationStore> {
  const store = await ConversationStore.open();
  openStores.push(store);
  return store;
}

it("writes, updates without overwriting, and keeps history", async () => {
  const store = await openStore();
  const first = await store.memories.write({
    agentId: DEFAULT_AGENT_ID,
    key: "color",
    content: "blue",
    kind: "profile",
    createdBy: "user",
  });
  const second = await store.memories.write({
    agentId: DEFAULT_AGENT_ID,
    key: "Color",
    content: "green",
    kind: "profile",
    createdBy: "model",
  });
  expect(second.previousId).toBe(first.memory.id);
  expect(second.memory.supersedes).toBe(first.memory.id);
  expect(second.memory.content).toBe("green");

  const updated = await store.memories.update({
    agentId: DEFAULT_AGENT_ID,
    key: "color",
    content: "red",
    kind: "profile",
    createdBy: "model",
  });
  expect(updated?.previousId).toBe(second.memory.id);
  expect(updated?.memory.content).toBe("red");

  const live = await store.memories.listLive(DEFAULT_AGENT_ID);
  expect(live.map((memory) => memory.content)).toEqual(["red"]);
  const history = (await store.memories.listForAgent(DEFAULT_AGENT_ID)).filter(
    (memory) => memory.validTo,
  );
  expect(history.map((memory) => memory.content).sort()).toEqual(["blue", "green"]);
  expect(history.every((memory) => memory.content !== "red")).toBe(true);
  const searched = await store.memories.search({
    agentId: DEFAULT_AGENT_ID,
    query: "color",
  });
  expect(searched.map((memory) => memory.content)).toEqual(["red"]);
});

it("does not retrieve a deleted memory or another agent's memory", async () => {
  const store = await openStore();
  await store.memories.write({
    agentId: DEFAULT_AGENT_ID,
    key: "city",
    content: "Lisbon",
    kind: "fact",
    createdBy: "user",
  });
  await store.memories.write({
    agentId: "other-agent",
    key: "city",
    content: "Atlantis harbor",
    kind: "profile",
    createdBy: "user",
  });
  await store.memories.softDeleteByKey(DEFAULT_AGENT_ID, "city");

  expect(await store.memories.listLive(DEFAULT_AGENT_ID)).toEqual([]);
  expect(await store.memories.search({ agentId: DEFAULT_AGENT_ID, query: "Lisbon" })).toEqual([]);
  expect(await store.memories.search({ agentId: DEFAULT_AGENT_ID, query: "Atlantis" })).toEqual([]);
  const other = await store.memories.listLive("other-agent");
  expect(other.map((memory) => memory.content)).toEqual(["Atlantis harbor"]);
});

it("forgets a memory when the delete key has extra spaces", async () => {
  const store = await openStore();
  await store.memories.write({
    agentId: DEFAULT_AGENT_ID,
    key: "favorite color",
    content: "blue",
    kind: "profile",
    createdBy: "user",
  });
  const forget = createMemoryTools(store).find((tool) => tool.name === "memory_delete");
  if (!forget?.prepare) throw new Error("missing memory_delete");
  const prepared = forget.prepare({ key: "  favorite   color  " });
  if (!("args" in prepared)) throw new Error(prepared.error);
  expect(prepared.args.key).toBe("favorite color");
  const result = await forget.invoke(prepared.args, {
    memory: {
      agentId: DEFAULT_AGENT_ID,
      conversationId: "conversation",
      sourceMessageId: null,
      userMessages: [],
      toolOutputs: [],
    },
  });
  expect(result.isError).toBeUndefined();
  expect(result.content).toContain('Forgot "favorite color"');
  expect(await store.memories.listLive(DEFAULT_AGENT_ID)).toEqual([]);
});

it("forgets a memory when the delete key is longer than 80 characters", async () => {
  const store = await openStore();
  const longKey = "k".repeat(80);
  await store.memories.write({
    agentId: DEFAULT_AGENT_ID,
    key: longKey,
    content: "a long key",
    kind: "fact",
    createdBy: "user",
  });
  const forget = createMemoryTools(store).find((tool) => tool.name === "memory_delete");
  if (!forget?.prepare) throw new Error("missing memory_delete");
  const prepared = forget.prepare({ key: `  ${longKey}extra` });
  if (!("args" in prepared)) throw new Error(prepared.error);
  expect(prepared.args.key).toBe(longKey);
  const result = await forget.invoke(prepared.args, {
    memory: {
      agentId: DEFAULT_AGENT_ID,
      conversationId: "conversation",
      sourceMessageId: null,
      userMessages: [],
      toolOutputs: [],
    },
  });
  expect(result.isError).toBeUndefined();
  expect(result.content).toContain(`Forgot "${longKey}"`);
  expect(await store.memories.listLive(DEFAULT_AGENT_ID)).toEqual([]);
});

it("blocks a planted API key and does not log the secret", async () => {
  const store = await openStore();
  const secret = "sk-test-1234567890abcdefghij";
  const warnings: string[] = [];
  const spy = vi.spyOn(console, "warn").mockImplementation((message) => {
    warnings.push(String(message));
  });
  try {
    const tools = createMemoryTools(store);
    const write = tools.find((tool) => tool.name === "memory_write");
    const prepared = write?.prepare?.({ key: "api key", text: `my API key is ${secret}` });
    expect(prepared && "args" in prepared).toBe(true);
    if (!prepared || !("args" in prepared) || !write) throw new Error("expected prepared args");
    const result = await write.invoke(prepared.args, {
      memory: {
        agentId: DEFAULT_AGENT_ID,
        conversationId: "conversation",
        sourceMessageId: null,
        userMessages: [`Remember that my API key is ${secret}`],
        toolOutputs: [],
      },
    });
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/not stored/i);
    expect(result.content).not.toContain(secret);
    expect(await store.memories.listForAgent(DEFAULT_AGENT_ID)).toEqual([]);
    expect(warnings.join("\n")).toContain("memory_write_blocked");
    expect(warnings.join("\n")).not.toContain(secret);
  } finally {
    spy.mockRestore();
  }
});

it("rejects tool output and accepts a fact the user stated", async () => {
  const store = await openStore();
  const tools = createMemoryTools(store);
  const turn = {
    memory: {
      agentId: DEFAULT_AGENT_ID,
      conversationId: "conversation",
      sourceMessageId: "message-1",
      userMessages: ["Please look up Paris", "Remember that my favorite color is blue"],
      toolOutputs: ["Paris population is 2100000 according to the fetched page"],
    },
  };
  const write = tools.find((tool) => tool.name === "memory_write");
  if (!write?.prepare) throw new Error("missing memory_write");
  const copied = write.prepare({
    key: "population",
    text: "Paris population is 2100000 according to the fetched page",
    kind: "fact",
  });
  if (!("args" in copied)) throw new Error(copied.error);
  const rejected = await write.invoke(copied.args, turn);
  expect(rejected.isError).toBe(true);

  const stated = write.prepare({
    key: "favorite color",
    text: "my favorite color is blue",
    kind: "profile",
  });
  if (!("args" in stated)) throw new Error(stated.error);
  const saved = await write.invoke(stated.args, turn);
  expect(saved.isError).toBeUndefined();
  const live = await store.memories.listLive(DEFAULT_AGENT_ID);
  expect(live.map((memory) => memory.content)).toEqual(["my favorite color is blue"]);
  expect(live[0]?.sourceMessageId).toBe("message-1");
});

it("tells the model to search for unlisted tools and to wait for approval", () => {
  const prompt = buildSystemPrompt({ profiles: [], facts: [] });
  expect(prompt).toContain(
    "If you need something that is not listed, call tool_search with a short query, then call the tool it returns.",
  );
  expect(prompt).toContain(
    "Tools that send, post, delete, pay, or invite someone wait until the person approves them.",
  );
  expect(prompt).toContain("call ask_user with a question, options, and allowCustom");
  expect(prompt).toContain("call propose_plan");
});

it("keeps profile memories inside the token budget in the system prompt", async () => {
  const store = await openStore();
  for (let index = 0; index < 40; index += 1) {
    await store.memories.write({
      agentId: DEFAULT_AGENT_ID,
      key: `preference-${index}`,
      content: `preference ${index} ${"bluebell ".repeat(30)}`,
      kind: "profile",
      createdBy: "user",
    });
  }
  const conversation = await seedConversation(store, "Budget");
  await store.addMessage(conversation.id, "user", "What should you know?");
  const input = await buildModelInput({ store, conversationId: conversation.id });
  const system = input?.messages.find((message) => message.role === "system")?.content ?? "";
  const block = sectionText(system, "profile-memories");
  expect(block.length).toBeGreaterThan(0);
  expect(estimateTokens(block)).toBeLessThanOrEqual(PROFILE_TOKEN_BUDGET);
  expect(
    input?.messages.filter((message) => message.role === "user").map((message) => message.content),
  ).toEqual(["What should you know?"]);
  expect(system).toContain("<profile-memories>");
  expect(
    input?.messages.some(
      (message) => message.role === "user" && message.content.includes("bluebell"),
    ),
  ).toBe(false);
});

it("retrieves a fact into the system prompt and not another agent's fact", async () => {
  const store = await openStore();
  await store.memories.write({
    agentId: DEFAULT_AGENT_ID,
    key: "project codename",
    content: "the project codename is silverline",
    kind: "fact",
    createdBy: "user",
  });
  await store.memories.write({
    agentId: "other-agent",
    key: "project codename",
    content: "the project codename is otherland",
    kind: "fact",
    createdBy: "user",
  });
  const conversation = await seedConversation(store, "Recall");
  await store.addMessage(conversation.id, "user", "What is the project codename?");
  const input = await buildModelInput({ store, conversationId: conversation.id });
  const system = input?.messages.find((message) => message.role === "system")?.content ?? "";
  expect(sectionText(system, "recalled-facts")).toContain("silverline");
  expect(system).not.toContain("otherland");
  expect(
    input?.messages.filter((message) => message.role === "user").map((message) => message.content),
  ).toEqual(["What is the project codename?"]);
});

it("flags card numbers, JWTs, and high entropy tokens, and ignores ordinary facts", () => {
  expect(findSecrets("my favorite color is blue")).toEqual([]);
  expect(findSecrets("card 4242424242424242")).toContain("card");
  expect(
    findSecrets(
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
    ),
  ).toContain("jwt");
  expect(findSecrets("token wJalrXUtnFEMI7MDENG8bPxRfiCYEXAMPLEKEY12")).toContain("high_entropy");
});

it("applies migrations once and refuses embedded postgres in production", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mockbot-memory-"));
  try {
    const first = await ConversationStore.open(dir);
    expect(await first.migrationIds()).toEqual([
      "001_conversations",
      "002_memory",
      "003_tool_trace",
      "004_connectors",
      "005_connector_tools",
      "006_auth",
      "007_composio_connections",
      "008_connector_catalog",
      "009_one_thread_per_agent",
      "010_ask_user",
      "011_run_events",
      "012_plan_mode",
      "013_site_tools",
      "014_connectors_user",
      "015_tool_call_scope",
      "016_waitlist",
      "017_agent_grants_and_routines",
    ]);
    expect(first.driver).toBe("pglite");
    await first.close();
    const second = await ConversationStore.open(dir);
    openStores.push(second);
    expect(await second.migrationIds()).toEqual([
      "001_conversations",
      "002_memory",
      "003_tool_trace",
      "004_connectors",
      "005_connector_tools",
      "006_auth",
      "007_composio_connections",
      "008_connector_catalog",
      "009_one_thread_per_agent",
      "010_ask_user",
      "011_run_events",
      "012_plan_mode",
      "013_site_tools",
      "014_connectors_user",
      "015_tool_call_scope",
      "016_waitlist",
      "017_agent_grants_and_routines",
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  await expect(
    openDatabase({ NODE_ENV: "production", DATA_DIR: "/tmp/mockbot-data" }),
  ).rejects.toThrow(/DATABASE_URL/);
  await expect(openDatabase({ VERCEL: "1" })).rejects.toThrow(/PGlite/);
});
