import { afterEach, expect, it } from "vitest";
import { summarizeMessages } from "../src/memory/compact";
import { sectionText } from "../src/memory/prompt";
import { estimateTokens, SUMMARY_TOKEN_BUDGET, trimToTokens } from "../src/memory/tokens";
import { ConversationStore } from "../src/store";
import { buildModelInput } from "../src/turn";
import { seedConversation } from "./helpers";

const openStores: ConversationStore[] = [];

afterEach(async () => {
  await Promise.all(openStores.splice(0).map((store) => store.close()));
});

it("summarizes older messages and keeps the recent tail verbatim", async () => {
  const store = await ConversationStore.open();
  openStores.push(store);
  const conversation = await seedConversation(store, "Long");
  for (let index = 0; index < 30; index += 1) {
    await store.addMessage(
      conversation.id,
      index % 2 === 0 ? "user" : "assistant",
      `Fact number ${index} ${"alpha ".repeat(80)}`,
    );
  }

  const input = await buildModelInput({
    store,
    conversationId: conversation.id,
    contextTokens: 2500,
  });
  const system = input?.messages.find((message) => message.role === "system")?.content ?? "";
  const summary = sectionText(system, "conversation-summary");
  expect(summary).toContain("Fact number 0");
  const stored = await store.getSummary(conversation.id);
  expect(stored?.summary).toContain("Fact number 0");

  const verbatim = input?.messages.filter((message) => message.role !== "system") ?? [];
  expect(verbatim.at(-1)?.content).toContain("Fact number 29");
  expect(verbatim.at(-1)?.content).toContain("alpha alpha");
  expect(verbatim.some((message) => message.content.includes("Fact number 0"))).toBe(false);
  expect(
    verbatim.some((message) => message.role === "user" && message.content.startsWith("- User:")),
  ).toBe(false);
});

it("compacts a chat whose weight is tool output rather than message text", async () => {
  const store = await ConversationStore.open();
  openStores.push(store);
  const conversation = await seedConversation(store, "Tools");
  await store.addMessage(conversation.id, "user", "EARLY_FACT please remember this");
  const heavy = await store.addMessage(conversation.id, "assistant", "Noted.");
  for (let index = 0; index < 8; index += 1) {
    await store.saveToolCall({
      id: `tool-heavy-${index}`,
      conversationId: conversation.id,
      messageId: heavy.id,
      name: "web_fetch",
      arguments: "{}",
      status: "done",
      output: `BLOB${index} ${"o".repeat(2000)}`,
    });
  }
  await store.addMessage(conversation.id, "user", "LATE_FACT what next");
  const visible = await store.addMessage(conversation.id, "assistant", "Done.");
  const output = `VISIBLE_TOOL_START ${"z".repeat(600)} HIDDEN_TOOL_END`;
  await store.saveToolCall({
    id: "tool-visible",
    conversationId: conversation.id,
    messageId: visible.id,
    name: "web_fetch",
    arguments: "{}",
    status: "done",
    output,
  });

  const input = await buildModelInput({
    store,
    conversationId: conversation.id,
    contextTokens: 2500,
  });
  const verbatim = input?.messages.filter((message) => message.role !== "system") ?? [];
  const verbatimText = verbatim.map((message) => message.content).join("\n");
  const stored = await store.getSummary(conversation.id);
  expect(stored?.summary).toContain("EARLY_FACT");
  expect(verbatimText).not.toContain("EARLY_FACT");
  expect(verbatimText).not.toContain("BLOB0");
  expect(verbatimText).toContain("LATE_FACT");
  expect(verbatimText).toContain("VISIBLE_TOOL_START");
  expect(verbatimText).not.toContain("HIDDEN_TOOL_END");
});

it("moves the summary past a tool-only turn when that turn is the oldest in range", async () => {
  const store = await ConversationStore.open();
  openStores.push(store);
  const conversation = await seedConversation(store, "Tool only");
  const toolOnly = await store.addMessage(conversation.id, "assistant", "   ");
  for (let index = 0; index < 8; index += 1) {
    await store.saveToolCall({
      id: `tool-only-${index}`,
      conversationId: conversation.id,
      messageId: toolOnly.id,
      name: "web_fetch",
      arguments: "{}",
      status: "done",
      output: `TOOL_ONLY_FACT ${index} ${"q".repeat(2000)}`,
    });
  }
  await store.addMessage(conversation.id, "user", "TAIL_NOTE still here");
  await store.addMessage(conversation.id, "user", "LATE_NOTE the recent one");

  const input = await buildModelInput({
    store,
    conversationId: conversation.id,
    contextTokens: 2500,
  });
  const stored = await store.getSummary(conversation.id);
  const loaded = await store.getConversation(conversation.id);
  const toolIndex = loaded?.messages.findIndex((message) => message.id === toolOnly.id) ?? -1;
  const uptoIndex =
    loaded?.messages.findIndex((message) => message.id === stored?.uptoMessageId) ?? -1;
  expect(toolIndex).toBe(0);
  expect(uptoIndex).toBeGreaterThanOrEqual(toolIndex);
  expect(stored?.summary).toContain("web_fetch (done): TOOL_ONLY_FACT");
  expect(stored?.summary).not.toMatch(/^- Assistant:\s*$/m);
  const verbatim = (input?.messages ?? [])
    .filter((message) => message.role !== "system")
    .map((message) => message.content)
    .join("\n");
  expect(verbatim).not.toContain("TOOL_ONLY_FACT");
  expect(verbatim).toContain("LATE_NOTE");
});

it("does not advance the summary past turns whose bullets would be empty", async () => {
  const store = await ConversationStore.open();
  openStores.push(store);
  const conversation = await seedConversation(store, "Dense");
  const total = 266;
  for (let index = 0; index < total; index += 1) {
    const marker = `Keep${String(index).padStart(4, "0")}`;
    await store.addMessage(
      conversation.id,
      index % 2 === 0 ? "user" : "assistant",
      `${marker} ${"x".repeat(2000)}`,
    );
  }

  const input = await buildModelInput({ store, conversationId: conversation.id });
  const stored = await store.getSummary(conversation.id);
  expect(stored?.summary).toBeTruthy();
  expect(stored?.summary ?? "").not.toMatch(/^- (?:User|Assistant):\s*$/m);
  for (const line of (stored?.summary ?? "").split("\n").filter(Boolean)) {
    expect(line).toMatch(/^- (?:User|Assistant): \S/);
  }
  const verbatim = (input?.messages ?? [])
    .filter((message) => message.role !== "system")
    .map((message) => message.content)
    .join("\n");
  expect(verbatim).toContain("Keep0256");
  expect(verbatim).toContain("Keep0259");
  const upto = stored?.uptoMessageId;
  const loaded = await store.getConversation(conversation.id);
  const uptoIndex = loaded?.messages.findIndex((message) => message.id === upto) ?? -1;
  expect(uptoIndex).toBeGreaterThanOrEqual(0);
  expect(uptoIndex).toBeLessThan(256);
  for (let index = 0; index <= uptoIndex; index += 1) {
    const marker = `Keep${String(index).padStart(4, "0")}`;
    expect(verbatim).not.toContain(marker);
    expect(stored?.summary).toContain("K");
  }
});

it("keeps newly compacted turns when the previous summary already fills the budget", () => {
  const previous = `OLDSTART ${"old ".repeat(2000)} OLDEND`;
  expect(estimateTokens(previous)).toBeGreaterThan(SUMMARY_TOKEN_BUDGET);
  const messages = Array.from({ length: 12 }, (_, index) => ({
    role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
    content: `Fresh fact ${index} ${"beta ".repeat(40)}`,
  }));
  const summarized = summarizeMessages(previous, messages);
  expect(summarized.covered).toBe(messages.length);
  expect(estimateTokens(summarized.summary)).toBeLessThanOrEqual(SUMMARY_TOKEN_BUDGET);
  expect(summarized.summary).toContain("Fresh fact 0");
  expect(summarized.summary).toContain("Fresh fact 11");
  expect(summarized.summary).not.toContain("OLDSTART");
  expect(trimToTokens(previous, 20, "end")).toContain("OLDEND");
  expect(trimToTokens(previous, 20, "end")).not.toContain("OLDSTART");
});
