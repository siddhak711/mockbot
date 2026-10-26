import { expect, it } from "vitest";
import { runtimeStatusLabel, showThinkingRow, tokenStreamEntries } from "../src/token-stream";
import type { MessageTrace } from "../src/types";

const fullTrace: MessageTrace = {
  started: true,
  role: "assistant",
  reasoning: "Plan the reply",
  tools: [{ index: 0, id: "1", name: "lookup", arguments: "{}", result: "ok" }],
  text: "Hello",
  finishReason: "stop",
  ended: true,
};

it("builds token stream rows from a stored assistant trace", () => {
  expect(tokenStreamEntries(fullTrace, "Hello")).toEqual([
    { kind: "start", label: "start", detail: "role assistant" },
    { kind: "reasoning", label: "reasoning", detail: "Plan the reply" },
    { kind: "tool", label: "lookup", detail: "done" },
    { kind: "text", label: "text", detail: "5 characters" },
    { kind: "end", label: "end", detail: "finish stop" },
  ]);
});

it("returns no rows when there is no trace", () => {
  expect(tokenStreamEntries(null)).toEqual([]);
});

it("shows a thinking row before the answer starts streaming", () => {
  expect(showThinkingRow(true, "start", false)).toBe(true);
  expect(showThinkingRow(true, "reasoning", false)).toBe(true);
  expect(showThinkingRow(true, "text", false)).toBe(false);
  expect(showThinkingRow(true, "reasoning", true)).toBe(false);
  expect(showThinkingRow(false, "reasoning", false)).toBe(false);
});

it("formats the sidebar runtime status without one truncated line", () => {
  expect(
    runtimeStatusLabel({
      provider: "openai",
      model: "deepseek/deepseek-v4.1-flash",
      database: "neon",
    }),
  ).toEqual({
    title: "deepseek/deepseek-v4.1-flash",
    subtitle: "OpenAI-compatible · Neon",
    full: "OpenAI-compatible · deepseek/deepseek-v4.1-flash · Neon",
  });
});
