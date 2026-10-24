import { afterEach, expect, it } from "vitest";
import { sectionText } from "../src/memory/prompt";
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
