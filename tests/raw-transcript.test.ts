import { expect, it } from "vitest";
import { renderRawTranscript } from "../src/raw-transcript";
import type { Message, MessageTrace } from "../src/types";

function message(partial: Partial<Message> & Pick<Message, "id" | "role" | "content">): Message {
  return {
    conversationId: "c",
    createdAt: "t",
    trace: null,
    ...partial,
  };
}

const trace: MessageTrace = {
  started: true,
  role: "assistant",
  reasoning: "Look it up.",
  tools: [
    {
      index: 0,
      id: "call_search",
      name: "web_search",
      arguments: '{"query":"mockbot"}',
      result: null,
    },
  ],
  text: "Done",
  finishReason: "stop",
  ended: true,
  system: "You are Mockbot.",
  prefill: "Answer:",
  segments: [
    { type: "reasoning", text: "Look it up." },
    { type: "tool", index: 0 },
    { type: "text", text: "Done" },
  ],
};

it("renders the full raw transcript with labels and no truncation", () => {
  const output = "x".repeat(2000);
  const text = renderRawTranscript(
    [
      message({ id: "u1", role: "user", content: "Hi" }),
      message({
        id: "a1",
        role: "assistant",
        content: "Done",
        trace,
      }),
    ],
    [
      {
        id: "call_search",
        messageId: "a1",
        name: "web_search",
        arguments: '{"query":"mockbot"}',
        output,
      },
    ],
  );

  expect(text).toBe(
    [
      "[SYSTEM]",
      "You are Mockbot.",
      "",
      "[USER]",
      "Hi",
      "",
      "[PREFILL]",
      "Answer:",
      "",
      "[ASSISTANT reasoning]",
      "Look it up.",
      "",
      "[TOOL CALL: web_search]",
      "id: call_search",
      "input:",
      '{"query":"mockbot"}',
      "output:",
      output,
      "",
      "[ASSISTANT text]",
      "Done",
    ].join("\n"),
  );
  expect(text).toContain(output);
  expect(text).not.toContain("…");
});

it("keeps tool calls that happened after text in that order", () => {
  const text = renderRawTranscript([
    message({ id: "u", role: "user", content: "Go" }),
    message({
      id: "a",
      role: "assistant",
      content: "First",
      trace: {
        started: true,
        role: "assistant",
        reasoning: "",
        tools: [
          {
            index: 0,
            id: "call_fetch",
            name: "web_fetch",
            arguments: '{"url":"https://example.com"}',
            result: "page body",
          },
        ],
        text: "First",
        finishReason: "stop",
        ended: true,
        segments: [
          { type: "text", text: "First" },
          { type: "tool", index: 0 },
        ],
      },
    }),
  ]);

  const textAt = text.indexOf("[ASSISTANT text]");
  const toolAt = text.indexOf("[TOOL CALL: web_fetch]");
  expect(textAt).toBeGreaterThan(-1);
  expect(toolAt).toBeGreaterThan(textAt);
  expect(text).toContain('input:\n{"url":"https://example.com"}');
  expect(text).toContain("output:\npage body");
});

it("shows a changed system prompt before the turn that used it", () => {
  const text = renderRawTranscript([
    message({ id: "u1", role: "user", content: "One" }),
    message({
      id: "a1",
      role: "assistant",
      content: "A",
      trace: {
        ...trace,
        system: "First prompt",
        prefill: "",
        reasoning: "",
        text: "A",
        segments: [],
        tools: [],
      },
    }),
    message({ id: "u2", role: "user", content: "Two" }),
    message({
      id: "a2",
      role: "assistant",
      content: "B",
      trace: {
        ...trace,
        system: "Second prompt",
        prefill: "",
        reasoning: "",
        text: "B",
        segments: [],
        tools: [],
      },
    }),
  ]);
  expect(text.indexOf("[SYSTEM]\nFirst prompt")).toBeLessThan(text.indexOf("[USER]\nOne"));
  expect(text.indexOf("[SYSTEM]\nSecond prompt")).toBeGreaterThan(
    text.indexOf("[ASSISTANT text]\nA"),
  );
  expect(text.indexOf("[SYSTEM]\nSecond prompt")).toBeLessThan(text.indexOf("[USER]\nTwo"));
});
