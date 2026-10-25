import { createServer } from "node:http";
import { once } from "node:events";
import { afterEach, expect, it } from "vitest";
import { POST } from "../app/api/chat/route";
import { resetAppContext, setAppContext } from "../src/context";
import {
  buildMockReasoning,
  buildMockReply,
  buildMockToolArguments,
  MOCK_TOOL_ID,
  MOCK_TOOL_NAME,
  MOCK_TOOL_RESULT,
  MockProvider,
  selectProvider,
  type LlmProvider,
} from "../src/llm";
import { SseParser } from "../src/sse";
import { ConversationStore } from "../src/store";
import { createDefaultTools } from "../src/tools/builtins";
import { emptyTrace } from "../src/trace";
import type { LlmMessage, LlmStreamEvent } from "../src/types";
import { deltas, readSse } from "./helpers";

afterEach(async () => {
  await resetAppContext();
});

function firstIndex(events: Array<{ event: string }>, name: string): number {
  return events.findIndex((event) => event.event === name);
}

it("streams start, reasoning, answer text, and end from the mock provider", async () => {
  const store = await ConversationStore.open();
  setAppContext({
    store,
    provider: selectProvider({ MOCK_STREAM_DELAY_MS: "0", MOCK_CHUNK_SIZE: "12" }),
  });

  const response = await POST(
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Say hello" }),
    }),
  );
  const events = await readSse(response);
  const kinds = events.map((event) => event.event);

  expect(firstIndex(events, "start")).toBeLessThan(firstIndex(events, "reasoning"));
  expect(firstIndex(events, "reasoning")).toBeLessThan(firstIndex(events, "delta"));
  expect(firstIndex(events, "delta")).toBeLessThan(firstIndex(events, "end"));
  expect(kinds).not.toContain("tool_call");
  expect(kinds).not.toContain("tool_result");
  expect(kinds.at(-1)).toBe("done");

  const start = events.find((event) => event.event === "start");
  expect(start?.data).toEqual({ role: "assistant" });
  const reasoning = events
    .filter((event) => event.event === "reasoning")
    .map((event) => String((event.data as { text?: string }).text ?? ""))
    .join("");
  expect(reasoning).toBe(buildMockReasoning("Say hello"));
  expect(deltas(events)).toBe(buildMockReply("Say hello"));
  expect(events.find((event) => event.event === "end")?.data).toEqual({ finishReason: "stop" });

  const loaded = await store.getConversation((await store.listConversations())[0]!.id);
  const assistant = loaded?.messages[1];
  expect(assistant?.content).toBe(buildMockReply("Say hello"));
  expect(assistant?.trace).toEqual({
    started: true,
    role: "assistant",
    reasoning,
    tools: [],
    text: buildMockReply("Say hello"),
    finishReason: "stop",
    ended: true,
  });
  expect(loaded?.messages[0]?.trace).toBeNull();
});

it("streams a scripted tool call only when the test option is set", async () => {
  const store = await ConversationStore.open();
  setAppContext({
    store,
    provider: new MockProvider({ delayMs: 0, chunkSize: 12, scriptToolCall: true }),
  });

  const response = await POST(
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Say hello" }),
    }),
  );
  const events = await readSse(response);

  expect(firstIndex(events, "reasoning")).toBeLessThan(firstIndex(events, "tool_call"));
  expect(firstIndex(events, "tool_call")).toBeLessThan(firstIndex(events, "tool_result"));
  expect(firstIndex(events, "tool_result")).toBeLessThan(firstIndex(events, "delta"));

  const calls = events.filter((event) => event.event === "tool_call");
  expect(calls.some((event) => (event.data as { name?: string }).name === MOCK_TOOL_NAME)).toBe(
    true,
  );
  expect(calls.some((event) => (event.data as { id?: string }).id === MOCK_TOOL_ID)).toBe(true);
  const args = calls
    .map((event) => String((event.data as { arguments?: string }).arguments ?? ""))
    .join("");
  expect(args).toBe(buildMockToolArguments("Say hello"));
  expect(events.find((event) => event.event === "tool_result")?.data).toEqual({
    id: MOCK_TOOL_ID,
    name: MOCK_TOOL_NAME,
    content: MOCK_TOOL_RESULT,
  });

  const loaded = await store.getConversation((await store.listConversations())[0]!.id);
  expect(loaded?.messages[1]?.trace?.tools).toEqual([
    {
      index: 0,
      id: MOCK_TOOL_ID,
      name: MOCK_TOOL_NAME,
      arguments: args,
      result: MOCK_TOOL_RESULT,
    },
  ]);
});

it("forwards upstream reasoning, tool calls, text, and the finish reason", async () => {
  const seen: { body?: string } = {};
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    seen.body = Buffer.concat(chunks).toString("utf8");
    const frames = [
      { choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { reasoning_content: "Think " }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { reasoning: "first." }, finish_reason: null }] },
      {
        choices: [
          {
            index: 0,
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
            finish_reason: null,
          },
        ],
      },
      {
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] },
            finish_reason: null,
          },
        ],
      },
      {
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, function: { arguments: '"Paris"}' } }] },
            finish_reason: null,
          },
        ],
      },
      { choices: [{ index: 0, delta: { content: "It is sunny." }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      "[DONE]",
    ];
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    for (const frame of frames) {
      response.write(`data: ${typeof frame === "string" ? frame : JSON.stringify(frame)}\n\n`);
    }
    response.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP port");

  try {
    const store = await ConversationStore.open();
    setAppContext({
      store,
      provider: selectProvider({
        LLM_PROVIDER: "openai",
        LLM_API_KEY: "sk-test",
        LLM_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
        LLM_MODEL: "gpt-4o-mini",
      }),
    });
    const response = await POST(
      new Request("http://localhost/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "Weather" }),
      }),
    );
    const events = await readSse(response);
    expect(JSON.parse(seen.body ?? "{}")).toMatchObject({ stream: true, model: "gpt-4o-mini" });
    expect(events.find((event) => event.event === "start")?.data).toEqual({ role: "assistant" });
    const reasoning = events
      .filter((event) => event.event === "reasoning")
      .map((event) => String((event.data as { text?: string }).text ?? ""))
      .join("");
    expect(reasoning).toBe("Think first.");
    expect(deltas(events)).toBe("It is sunny.");
    const args = events
      .filter((event) => event.event === "tool_call")
      .map((event) => String((event.data as { arguments?: string }).arguments ?? ""))
      .join("");
    expect(args).toBe('{"city":"Paris"}');
    expect(events.some((event) => (event.data as { name?: string }).name === "get_weather")).toBe(
      true,
    );
    expect(events.filter((event) => event.event === "end")).toEqual([
      { event: "end", data: { finishReason: "stop" } },
    ]);

    const loaded = await store.getConversation((await store.listConversations())[0]!.id);
    expect(loaded?.messages[1]?.trace?.tools[0]).toMatchObject({
      id: "call_1",
      name: "get_weather",
      arguments: '{"city":"Paris"}',
      result: null,
    });
    expect(loaded?.messages[1]?.trace?.finishReason).toBe("stop");
    expect(loaded?.messages[1]?.content).toBe("It is sunny.");
  } finally {
    server.close();
  }
});

it("keeps partial reasoning and a partial tool call when the stream is stopped", async () => {
  const provider: LlmProvider = {
    id: "mock",
    model: null,
    async *stream(_messages: LlmMessage[], signal?: AbortSignal): AsyncIterable<LlmStreamEvent> {
      yield { type: "start", role: "assistant" };
      yield { type: "reasoning", text: "Partial thought" };
      yield {
        type: "tool_call",
        index: 0,
        id: "call_x",
        name: "lookup_context",
        arguments: '{"q":',
      };
      await new Promise<void>((_resolve, reject) => {
        const fail = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        if (signal?.aborted) {
          fail();
          return;
        }
        signal?.addEventListener("abort", fail, { once: true });
      });
      yield { type: "text", text: "should not keep" };
    },
  };
  const store = await ConversationStore.open();
  setAppContext({ store, provider });
  const controller = new AbortController();
  const response = await POST(
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Remember this" }),
      signal: controller.signal,
    }),
  );

  const parser = new SseParser();
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let sawTool = false;
  while (!sawTool) {
    const { value, done } = await reader.read();
    expect(done).toBe(false);
    const events = parser.push(decoder.decode(value, { stream: true }));
    sawTool = events.some((event) => event.event === "tool_call");
  }
  controller.abort();
  try {
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }
  } catch (error) {
    if (!(error instanceof Error) || error.name !== "AbortError") throw error;
  }

  const loaded = await store.getConversation((await store.listConversations())[0]!.id);
  expect(loaded?.messages.map((message) => [message.role, message.content])).toEqual([
    ["user", "Remember this"],
    ["assistant", ""],
  ]);
  expect(loaded?.messages[1]?.trace?.reasoning).toBe("Partial thought");
  expect(loaded?.messages[1]?.trace?.tools[0]).toMatchObject({
    id: "call_x",
    name: "lookup_context",
    arguments: '{"q":',
    result: null,
  });
  expect(loaded?.messages[1]?.trace?.ended).toBe(false);
});

it("does not send an empty partial assistant message back to the model", async () => {
  const seen: LlmMessage[][] = [];
  const provider: LlmProvider = {
    id: "mock",
    model: null,
    async *stream(messages: LlmMessage[]): AsyncIterable<LlmStreamEvent> {
      seen.push(messages);
      yield { type: "text", text: "Next" };
      yield { type: "end", finishReason: "stop" };
    },
  };
  const store = await ConversationStore.open();
  setAppContext({ store, provider });
  const conversation = await store.createConversation("Existing");
  await store.addMessage(conversation.id, "user", "First");
  await store.addMessage(conversation.id, "assistant", "", {
    ...emptyTrace(),
    started: true,
    reasoning: "half",
  });

  const response = await POST(
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Continue", conversationId: conversation.id }),
    }),
  );
  await readSse(response);
  const outbound = seen[0]?.map((message) => message.content) ?? [];
  expect(outbound).toContain("Continue");
  expect(outbound).not.toContain("");
  expect(outbound).not.toContain("half");
});

it("does not call a tool when the message only mentions calling one", async () => {
  const provider = new MockProvider({ delayMs: 0, chunkSize: 200 });
  const tools = createDefaultTools({}).list();
  const events: LlmStreamEvent[] = [];
  for await (const event of provider.stream(
    [{ role: "user", content: "can you call web_search later" }],
    { tools },
  )) {
    events.push(event);
  }
  expect(events.some((event) => event.type === "tool_call")).toBe(false);
  const text = events
    .filter((event) => event.type === "text")
    .map((event) => (event.type === "text" ? event.text : ""))
    .join("");
  expect(text).toBe(buildMockReply("can you call web_search later"));
});
