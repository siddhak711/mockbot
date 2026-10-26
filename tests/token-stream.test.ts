import { expect, it } from "vitest";
import { isLiveTraceTurn } from "../components/token-stream";
import { assistantHasVisibleBody, liveAssistantId } from "../components/transcript";
import { runtimeStatusLabel, showThinkingRow, tokenStreamEntries } from "../src/token-stream";
import type { ToolActivity } from "../src/tools/display";
import type { Message, MessageTrace } from "../src/types";

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

it("binds the live turn to the assistant after the latest user message", () => {
  const messages: Message[] = [
    {
      id: "u1",
      conversationId: "c",
      role: "user",
      content: "hi",
      createdAt: "t0",
      trace: null,
    },
    {
      id: "a1",
      conversationId: "c",
      role: "assistant",
      content: "old",
      createdAt: "t1",
      trace: null,
    },
    {
      id: "u2",
      conversationId: "c",
      role: "user",
      content: "again",
      createdAt: "t2",
      trace: null,
    },
  ];
  expect(liveAssistantId(messages, true)).toBeNull();
  expect(
    liveAssistantId(
      [
        ...messages,
        {
          id: "a2",
          conversationId: "c",
          role: "assistant",
          content: "",
          createdAt: "t3",
          trace: null,
        },
      ],
      true,
    ),
  ).toBe("a2");
  expect(liveAssistantId(messages, false)).toBeNull();
});

it("keeps tool-only assistants out of the chat until text or an approval arrives", () => {
  const empty: Message = {
    id: "a2",
    conversationId: "c",
    role: "assistant",
    content: "",
    createdAt: "t3",
    trace: {
      started: true,
      role: "assistant",
      reasoning: "planning",
      tools: [],
      text: "",
      finishReason: null,
      ended: false,
    },
  };
  const approval: ToolActivity = {
    id: "1",
    messageId: "a2",
    name: "send",
    title: "Send",
    detail: "",
    arguments: "{}",
    output: "",
    preview: "",
    summary: "Send it?",
    state: "approval",
    kind: "draft",
  };
  expect(assistantHasVisibleBody(empty)).toBe(false);
  expect(
    assistantHasVisibleBody({
      ...empty,
      content: "Hello",
    }),
  ).toBe(true);
  expect(
    assistantHasVisibleBody({
      ...empty,
      trace: {
        ...empty.trace!,
        tools: [{ index: 0, id: "1", name: "web_fetch", arguments: "{}", result: "page" }],
      },
    }),
  ).toBe(false);
  expect(assistantHasVisibleBody(empty, [approval])).toBe(true);
  expect(assistantHasVisibleBody(empty, [{ ...approval, state: "done" }])).toBe(false);
});

it("hides an empty assistant after stop or a finish that produced nothing", () => {
  const empty: Message = {
    id: "a2",
    conversationId: "c",
    role: "assistant",
    content: "  ",
    createdAt: "t3",
    trace: {
      started: true,
      role: "assistant",
      reasoning: "planning",
      tools: [],
      text: "",
      finishReason: "stop",
      ended: true,
    },
  };
  expect(assistantHasVisibleBody(empty)).toBe(false);
  expect(assistantHasVisibleBody({ ...empty, content: "partial" })).toBe(true);
});

it("does not mark the previous trace turn live before the new assistant exists", () => {
  const previous: Message = {
    id: "a1",
    conversationId: "c",
    role: "assistant",
    content: "old",
    createdAt: "t1",
    trace: fullTrace,
  };
  const sent: Message[] = [
    {
      id: "u1",
      conversationId: "c",
      role: "user",
      content: "hi",
      createdAt: "t0",
      trace: null,
    },
    previous,
    {
      id: "u2",
      conversationId: "c",
      role: "user",
      content: "again",
      createdAt: "t2",
      trace: null,
    },
  ];
  expect(isLiveTraceTurn(previous.id, sent, true)).toBe(false);
  const current: Message = {
    id: "a2",
    conversationId: "c",
    role: "assistant",
    content: "",
    createdAt: "t3",
    trace: { ...fullTrace, text: "", ended: false, finishReason: null },
  };
  const streaming = [...sent, current];
  expect(isLiveTraceTurn(current.id, streaming, true)).toBe(true);
  expect(isLiveTraceTurn(previous.id, streaming, true)).toBe(false);
  expect(isLiveTraceTurn(current.id, streaming, false)).toBe(false);
});
