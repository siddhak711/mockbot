import { expect, it } from "vitest";
import { readOpenAiEvents } from "../src/openai-events";

it("reads role, reasoning, tool call fragments, text, and the finish reason", () => {
  expect(
    readOpenAiEvents({
      choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
    }),
  ).toEqual([{ type: "start", role: "assistant" }]);

  expect(
    readOpenAiEvents({
      choices: [{ delta: { reasoning_content: "Think " }, finish_reason: null }],
    }),
  ).toEqual([{ type: "reasoning", text: "Think " }]);

  expect(
    readOpenAiEvents({
      choices: [{ delta: { reasoning: "more" } }],
    }),
  ).toEqual([{ type: "reasoning", text: "more" }]);

  expect(
    readOpenAiEvents({
      choices: [{ delta: { thinking: "wait" } }],
    }),
  ).toEqual([{ type: "reasoning", text: "wait" }]);

  expect(
    readOpenAiEvents({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_1",
                type: "function",
                function: { name: "get_weather", arguments: "" },
              },
            ],
          },
        },
      ],
    }),
  ).toEqual([{ type: "tool_call", index: 0, id: "call_1", name: "get_weather" }]);

  expect(
    readOpenAiEvents({
      choices: [
        {
          delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":"Paris"}' } }] },
          finish_reason: "tool_calls",
        },
      ],
    }),
  ).toEqual([
    { type: "tool_call", index: 0, arguments: '{"city":"Paris"}' },
    { type: "end", finishReason: "tool_calls" },
  ]);
});

it("reads reasoning objects, content parts, legacy function calls, and refusals", () => {
  expect(
    readOpenAiEvents({
      choices: [{ delta: { reasoning: { text: "hmm" } }, finish_reason: null }],
    }),
  ).toEqual([{ type: "reasoning", text: "hmm" }]);

  expect(
    readOpenAiEvents({
      choices: [
        {
          delta: {
            content: [
              { type: "reasoning", text: "because" },
              { type: "text", text: "Answer" },
            ],
          },
          finish_reason: "length",
        },
      ],
    }),
  ).toEqual([
    { type: "reasoning", text: "because" },
    { type: "text", text: "Answer" },
    { type: "end", finishReason: "length" },
  ]);

  expect(
    readOpenAiEvents({
      choices: [
        {
          delta: { function_call: { name: "get_weather", arguments: '{"a":1}' } },
          finish_reason: "function_call",
        },
      ],
    }),
  ).toEqual([
    { type: "tool_call", index: 0, name: "get_weather", arguments: '{"a":1}' },
    { type: "end", finishReason: "function_call" },
  ]);

  expect(
    readOpenAiEvents({
      choices: [{ delta: { refusal: "No." }, finish_reason: "stop" }],
    }),
  ).toEqual([
    { type: "text", text: "No." },
    { type: "end", finishReason: "stop" },
  ]);

  expect(readOpenAiEvents({ choices: [] })).toEqual([]);
  expect(readOpenAiEvents(null)).toEqual([]);
});
