import { expect, it } from "vitest";
import {
  applyClientEvent,
  applyStreamEvent,
  emptyTrace,
  modelPromptParts,
  parseTrace,
  phaseFromEvent,
  streamedWeight,
} from "../src/trace";
import type { Message } from "../src/types";

function blank(): Message {
  return {
    id: "local-1",
    conversationId: "c1",
    role: "assistant",
    content: "",
    createdAt: "2026-01-01T00:00:00.000Z",
    trace: emptyTrace(),
  };
}

it("folds start, reasoning, tool call, result, text, and end into one trace", () => {
  let trace = emptyTrace();
  trace = applyStreamEvent(trace, { type: "start", role: "assistant" });
  trace = applyStreamEvent(trace, { type: "reasoning", text: "Look " });
  trace = applyStreamEvent(trace, { type: "reasoning", text: "it up." });
  trace = applyStreamEvent(trace, {
    type: "tool_call",
    index: 0,
    id: "call_1",
    name: "look",
  });
  trace = applyStreamEvent(trace, { type: "tool_call", index: 0, name: "up" });
  trace = applyStreamEvent(trace, { type: "tool_call", index: 0, arguments: '{"q":' });
  trace = applyStreamEvent(trace, { type: "tool_call", index: 0, arguments: "1}" });
  trace = applyStreamEvent(trace, {
    type: "tool_result",
    id: "call_1",
    name: "lookup",
    content: "ok",
  });
  trace = applyStreamEvent(trace, { type: "text", text: "Answer" });
  trace = applyStreamEvent(trace, { type: "end", finishReason: "stop" });

  expect(trace).toEqual({
    started: true,
    role: "assistant",
    reasoning: "Look it up.",
    tools: [
      {
        index: 0,
        id: "call_1",
        name: "lookup",
        arguments: '{"q":1}',
        result: "ok",
      },
    ],
    text: "Answer",
    finishReason: "stop",
    ended: true,
    system: "",
    prefill: "",
    segments: [
      { type: "reasoning", text: "Look it up." },
      { type: "tool", index: 0 },
      { type: "text", text: "Answer" },
    ],
  });
});

it("keeps a repeated tool name and a longer cumulative name", () => {
  let trace = applyStreamEvent(emptyTrace(), {
    type: "tool_call",
    index: 0,
    name: "lookup_context",
  });
  trace = applyStreamEvent(trace, { type: "tool_call", index: 0, name: "lookup_context" });
  expect(trace.tools[0]?.name).toBe("lookup_context");
  trace = applyStreamEvent(trace, { type: "tool_call", index: 0, name: "lookup_context_v2" });
  expect(trace.tools[0]?.name).toBe("lookup_context_v2");
});

it("applies the same events from SSE payloads the client receives", () => {
  const steps: Array<[string, Record<string, unknown>]> = [
    ["start", { role: "assistant" }],
    ["reasoning", { text: "Hmm" }],
    ["tool_call", { index: 0, id: "call_lookup", name: "lookup_context" }],
    ["tool_call", { index: 0, arguments: '{"query":"Hi"}' }],
    ["tool_result", { id: "call_lookup", name: "lookup_context", content: "local" }],
    ["delta", { text: "Hello" }],
    ["end", { finishReason: "length" }],
  ];
  const message = steps.reduce(
    (current, [event, data]) => applyClientEvent(current, event, data),
    blank(),
  );
  expect(message.content).toBe("Hello");
  expect(message.trace?.reasoning).toBe("Hmm");
  expect(message.trace?.tools[0]).toEqual({
    index: 0,
    id: "call_lookup",
    name: "lookup_context",
    arguments: '{"query":"Hi"}',
    result: "local",
  });
  expect(message.trace?.finishReason).toBe("length");
  expect(message.trace?.ended).toBe(true);
  expect(phaseFromEvent("tool_result")).toBe("tool");
  expect(phaseFromEvent("delta")).toBe("text");
  expect(streamedWeight(message)).toBeGreaterThan(message.content.length);
});

it("parses a stored trace and drops garbage", () => {
  expect(parseTrace(null)).toBeNull();
  expect(parseTrace("not-json")).toBeNull();
  expect(
    parseTrace(
      '{"started":true,"reasoning":"x","tools":[{"name":"lookup"}],"ended":true,"finishReason":"stop"}',
    ),
  ).toEqual({
    started: true,
    role: null,
    reasoning: "x",
    tools: [{ index: 0, id: "", name: "lookup", arguments: "", result: null }],
    text: "",
    finishReason: "stop",
    ended: true,
    system: "",
    prefill: "",
    segments: [],
  });
});

it("records the system prompt and a trailing assistant prefill", () => {
  expect(
    modelPromptParts([
      { role: "system", content: "Be brief." },
      { role: "system", content: "Use tools." },
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Sure," },
    ]),
  ).toEqual({ system: "Be brief.\n\nUse tools.", prefill: "Sure," });
  expect(
    modelPromptParts([
      { role: "system", content: "Be brief." },
      { role: "user", content: "Hi" },
    ]),
  ).toEqual({ system: "Be brief.", prefill: "" });
  expect(
    modelPromptParts([
      { role: "user", content: "Hi" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "lookup", arguments: "{}" } },
        ],
      },
    ]),
  ).toEqual({ system: "", prefill: "" });
});

it("stores a prompt event on the assistant trace", () => {
  const message = applyClientEvent(blank(), "prompt", {
    system: "You are Mockbot.",
    prefill: "Answer:",
  });
  expect(message.trace?.system).toBe("You are Mockbot.");
  expect(message.trace?.prefill).toBe("Answer:");
});
