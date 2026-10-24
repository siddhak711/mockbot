import { afterEach, expect, it } from "vitest";
import { summarizeMessages } from "../src/memory/compact";
import { sectionText } from "../src/memory/prompt";
import { estimateTokens, SUMMARY_TOKEN_BUDGET, trimToTokens } from "../src/memory/tokens";
import { ConversationStore } from "../src/store";
import { buildModelInput } from "../src/turn";

const openStores: ConversationStore[] = [];

afterEach(async () => {
  await Promise.all(openStores.splice(0).map((store) => store.close()));
});

it("summarizes older messages and keeps the recent tail verbatim", async () => {
  const store = await ConversationStore.open();
  openStores.push(store);
  const conversation = await store.createConversation("Long");
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
