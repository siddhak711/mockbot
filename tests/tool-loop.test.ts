import { createServer, type ServerResponse } from "node:http";
import { once } from "node:events";
import { afterEach, expect, it } from "vitest";
import { POST as postChat } from "../app/api/chat/route";
import { GET as readConversation } from "../app/api/conversations/[id]/route";
import { POST as postApproval } from "../app/api/tools/approvals/route";
import { resetAppContext, setAppContext } from "../src/context";
import { MockProvider, selectProvider, streamOptions, type LlmProvider } from "../src/llm";
import { SseParser } from "../src/sse";
import { ConversationStore } from "../src/store";
import { ApprovalGate } from "../src/tools/approval";
import { createDefaultTools } from "../src/tools/builtins";
import { toolSearchTool, ToolRegistry } from "../src/tools/registry";
import type { LlmMessage, LlmStreamEvent, StoredToolCall } from "../src/types";
import type { ToolDefinition } from "../src/tools/types";
import { deltas, readSse } from "./helpers";

afterEach(async () => {
  await resetAppContext();
});

type SseEvent = { event: string; data: Record<string, unknown> };

type ScriptedEvent =
  | { type: "text"; text: string }
  | { type: "tool_call"; id: string; name?: string; argumentsDelta: string };

class ScriptedProvider implements LlmProvider {
  readonly id = "mock" as const;
  readonly model = null;
  readonly seen: string[][] = [];
  #turn = 0;

  constructor(private readonly turns: ScriptedEvent[][]) {}

  async *stream(_messages: LlmMessage[], input?: AbortSignal): AsyncIterable<LlmStreamEvent> {
    const { tools = [] } = streamOptions(input);
    this.seen.push(tools.map((tool) => tool.name));
    const turn = this.turns[this.#turn] ?? [{ type: "text", text: "Done." }];
    this.#turn += 1;
    const indexes = new Map<string, number>();
    for (const event of turn) {
      if (event.type === "text") {
        yield { type: "text", text: event.text };
        continue;
      }
      const first = !indexes.has(event.id);
      let index = indexes.get(event.id);
      if (index === undefined) {
        index = indexes.size;
        indexes.set(event.id, index);
      }
      yield {
        type: "tool_call",
        index,
        ...(first ? { id: event.id } : {}),
        ...(event.name ? { name: event.name } : {}),
        ...(event.argumentsDelta ? { arguments: event.argumentsDelta } : {}),
      };
    }
  }
}

function demoProvider(chunkSize: number): MockProvider {
  return new MockProvider({ delayMs: 0, chunkSize, demoTools: true });
}

async function readUntil(response: Response, eventName: string) {
  if (!response.body) throw new Error("Expected a response body");
  const parser = new SseParser();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events: SseEvent[] = [];
  const timeout = setTimeout(() => reader.cancel(), 5_000);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const message of parser.push(decoder.decode(value, { stream: true }))) {
        const event = {
          event: message.event,
          data: JSON.parse(message.data) as Record<string, unknown>,
        };
        events.push(event);
        if (event.event === eventName) {
          clearTimeout(timeout);
          return { events, reader, parser, decoder };
        }
      }
    }
  } finally {
    clearTimeout(timeout);
  }
  throw new Error(`Stream ended before ${eventName}`);
}

async function readRest(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  parser: SseParser,
  decoder: TextDecoder,
): Promise<SseEvent[]> {
  const events: SseEvent[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const message of parser.push(decoder.decode(value, { stream: true }))) {
      events.push({
        event: message.event,
        data: JSON.parse(message.data) as Record<string, unknown>,
      });
    }
  }
  return events;
}

function toolEvents(events: SseEvent[], name: string): SseEvent[] {
  return events.filter((event) => event.event === name);
}

it("streams a mock tool_search and web_search before the reply and stores the cards", async () => {
  const store = await ConversationStore.open();
  setAppContext({
    store,
    provider: demoProvider(12),
  });

  const response = await postChat(
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Say hello" }),
    }),
  );
  const events = (await readSse(response)) as SseEvent[];
  const order = events.map((event) => event.event).filter((event) => event !== "delta");
  expect(order[0]).toBe("meta");
  expect(order).toContain("tool_start");
  expect(order).toContain("tool_args");
  expect(order).toContain("tool_result");
  expect(order.at(-1)).toBe("done");
  expect(order).not.toContain("approval_required");

  const starts = toolEvents(events, "tool_start").map((event) => event.data.name);
  expect(starts).toEqual(["tool_search", "web_search"]);
  const searchArgs = toolEvents(events, "tool_args").filter((event) =>
    String(event.data.arguments).includes("web search"),
  );
  expect(searchArgs.length).toBeGreaterThan(0);
  const results = toolEvents(events, "tool_result");
  expect(results.map((event) => event.data.status)).toEqual(["done", "done"]);
  expect(String(results[1]?.data.output)).toContain("Say hello");
  expect(deltas(events)).toContain("mock reply");

  const loaded = await store.getConversation((await store.listConversations())[0]!.id);
  const assistant = loaded?.messages.find((message) => message.role === "assistant");
  expect(assistant?.tools?.map((tool) => [tool.name, tool.status])).toEqual([
    ["tool_search", "done"],
    ["web_search", "done"],
  ]);

  const params = { params: Promise.resolve({ id: loaded!.conversation.id }) };
  const body = (await (await readConversation(new Request("http://localhost"), params)).json()) as {
    messages: Array<{ role: string; tools?: StoredToolCall[] }>;
  };
  expect(body.messages.find((message) => message.role === "assistant")?.tools).toHaveLength(2);
});

it("pauses a write tool on an approval card and continues after the decision", async () => {
  const store = await ConversationStore.open();
  setAppContext({
    store,
    provider: demoProvider(20),
  });
  const response = await postChat(
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Schedule a planning meeting tomorrow and invite the team" }),
    }),
  );
  const pending = await readUntil(response, "approval_required");
  const approval = pending.events.find((event) => event.event === "approval_required");
  expect(approval?.data.name).toBe("google_calendar");
  expect(String(approval?.data.summary)).toContain("team@example.com");
  expect(toolEvents(pending.events, "tool_start").map((event) => event.data.name)).toEqual([
    "tool_search",
    "google_calendar",
  ]);

  const decision = await postApproval(
    new Request("http://localhost/api/tools/approvals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: approval?.data.id, decision: "approve" }),
    }),
  );
  expect(decision.status).toBe(200);

  const rest = await readRest(pending.reader, pending.parser, pending.decoder);
  const events = [...pending.events, ...rest];
  const running = events.find(
    (event) => event.event === "tool_status" && event.data.id === approval?.data.id,
  );
  const calendarResult = toolEvents(events, "tool_result").find(
    (event) => event.data.name === "google_calendar",
  );
  expect(running?.data.status).toBe("running");
  expect(events.indexOf(running!)).toBeLessThan(events.indexOf(calendarResult!));
  expect(calendarResult?.data.status).toBe("done");
  expect(String(calendarResult?.data.output)).toContain("evt_mock");
  expect(deltas(events)).toContain("planning meeting");
  expect(events.at(-1)?.event).toBe("done");

  const loaded = await store.getConversation((await store.listConversations())[0]!.id);
  const tools = loaded?.messages.find((message) => message.role === "assistant")?.tools ?? [];
  expect(tools.map((tool) => tool.status)).toEqual(["done", "done"]);
});

it("records a denial and still lets the conversation continue", async () => {
  const store = await ConversationStore.open();
  setAppContext({
    store,
    provider: demoProvider(40),
  });
  const response = await postChat(
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Please invite the team" }),
    }),
  );
  const pending = await readUntil(response, "approval_required");
  const id = String(pending.events.find((event) => event.event === "approval_required")?.data.id);
  const decision = await postApproval(
    new Request("http://localhost/api/tools/approvals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, decision: "deny" }),
    }),
  );
  expect(decision.status).toBe(200);
  const rest = await readRest(pending.reader, pending.parser, pending.decoder);
  const events = [...pending.events, ...rest];
  const calendarResult = toolEvents(events, "tool_result").find(
    (event) => event.data.name === "google_calendar",
  );
  expect(calendarResult?.data.status).toBe("denied");
  expect(deltas(events)).toContain("denied");

  const missing = await postApproval(
    new Request("http://localhost/api/tools/approvals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, decision: "approve" }),
    }),
  );
  expect(missing.status).toBe(404);
  const bad = await postApproval(
    new Request("http://localhost/api/tools/approvals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "x", decision: "maybe" }),
    }),
  );
  expect(bad.status).toBe(400);
});

it("keeps a pending approval when the chat client disconnects", async () => {
  const store = await ConversationStore.open();
  setAppContext({
    store,
    provider: demoProvider(40),
  });
  const controller = new AbortController();
  const response = await postChat(
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({ message: "Schedule a planning meeting tomorrow and invite the team" }),
    }),
  );
  const pending = await readUntil(response, "approval_required");
  const id = String(pending.events.find((event) => event.event === "approval_required")?.data.id);
  controller.abort();
  await pending.reader.cancel().catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 50));

  const conversationId = (await store.listConversations())[0]!.id;
  const before = await store.getConversation(conversationId);
  const waiting = before?.messages
    .find((message) => message.role === "assistant")
    ?.tools?.find((tool) => tool.name === "google_calendar");
  expect(waiting?.status).toBe("approval");

  const decision = await postApproval(
    new Request("http://localhost/api/tools/approvals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, decision: "approve" }),
    }),
  );
  expect(decision.status).toBe(200);

  let status = waiting?.status;
  for (let attempt = 0; attempt < 40 && status !== "done"; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    const loaded = await store.getConversation(conversationId);
    status = loaded?.messages
      .find((message) => message.role === "assistant")
      ?.tools?.find((tool) => tool.id === id)?.status;
  }
  expect(status).toBe("done");
});

it("ends a pending approval on an explicit stop", async () => {
  const store = await ConversationStore.open();
  setAppContext({
    store,
    provider: demoProvider(40),
  });
  const response = await postChat(
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Please invite the team" }),
    }),
  );
  const pending = await readUntil(response, "approval_required");
  const id = String(pending.events.find((event) => event.event === "approval_required")?.data.id);
  const decision = await postApproval(
    new Request("http://localhost/api/tools/approvals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, decision: "stop" }),
    }),
  );
  expect(decision.status).toBe(200);
  const rest = await readRest(pending.reader, pending.parser, pending.decoder);
  const events = [...pending.events, ...rest];
  const calendarResult = toolEvents(events, "tool_result").find(
    (event) => event.data.name === "google_calendar",
  );
  expect(calendarResult).toBeUndefined();
  expect(deltas(events)).not.toContain("created a **planning meeting**");
  const loaded = await store.getConversation((await store.listConversations())[0]!.id);
  const calendar = loaded?.messages
    .find((message) => message.role === "assistant")
    ?.tools?.find((tool) => tool.id === id);
  expect(calendar?.status).toBe("error");
  expect(calendar?.output).toContain("Stopped before the tool ran.");
  const again = await postApproval(
    new Request("http://localhost/api/tools/approvals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, decision: "approve" }),
    }),
  );
  expect(again.status).toBe(404);
});

it("closes a timed-out calendar invite as a denial", async () => {
  const store = await ConversationStore.open();
  setAppContext({
    store,
    provider: demoProvider(80),
    approvals: new ApprovalGate(30),
  });
  const response = await postChat(
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Schedule a planning meeting tomorrow and invite the team",
      }),
    }),
  );
  const events = (await readSse(response)) as SseEvent[];
  const calendarResult = toolEvents(events, "tool_result").find(
    (event) => event.data.name === "google_calendar",
  );
  expect(calendarResult?.data.status).toBe("denied");
  expect(String(calendarResult?.data.output)).toContain("Approval timed out");
  expect(deltas(events)).toContain("denied");
  expect(deltas(events)).not.toContain("created a **planning meeting**");
  expect(events.at(-1)?.event).toBe("done");
});

it("shows a tool failure in the stream and keeps the conversation usable", async () => {
  const store = await ConversationStore.open();
  const provider = new ScriptedProvider([
    [
      { type: "tool_call", id: "call_missing", name: "missing_tool", argumentsDelta: "" },
      { type: "tool_call", id: "call_missing", argumentsDelta: "{}" },
    ],
    [{ type: "text", text: "Recovered." }],
  ]);
  setAppContext({ store, provider });
  const response = await postChat(
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Try a missing tool" }),
    }),
  );
  const events = (await readSse(response)) as SseEvent[];
  const result = toolEvents(events, "tool_result")[0];
  expect(result?.data.status).toBe("error");
  expect(String(result?.data.output)).toContain("Unknown tool");
  expect(deltas(events)).toBe("Recovered.");

  const followUp = await postChat(
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Again",
        conversationId: (await store.listConversations())[0]!.id,
      }),
    }),
  );
  const next = await readSse(followUp);
  expect(deltas(next)).toBe("Done.");
  expect(next.at(-1)?.event).toBe("done");
});

it("promotes a hidden tool the model found with tool_search", async () => {
  const registry = new ToolRegistry();
  registry.register(toolSearchTool(registry));
  for (let index = 0; index < 14; index += 1) {
    registry.register(stub(`tool_${String(index).padStart(2, "0")}`));
  }
  registry.register({
    ...stub("archive_lookup"),
    exposure: "hidden",
    description: "Search the secret archive",
  });
  const provider = new ScriptedProvider([
    [
      { type: "tool_call", id: "call_search", name: "tool_search", argumentsDelta: "" },
      {
        type: "tool_call",
        id: "call_search",
        argumentsDelta: JSON.stringify({ query: "secret archive" }),
      },
    ],
    [{ type: "text", text: "Found it." }],
  ]);
  const store = await ConversationStore.open();
  setAppContext({ store, provider, tools: registry });
  const response = await postChat(
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Look in the archive" }),
    }),
  );
  const events = await readSse(response);
  expect(deltas(events)).toBe("Found it.");
  expect(provider.seen[0]).toHaveLength(15);
  expect(provider.seen[0]).not.toContain("archive_lookup");
  expect(provider.seen[1]).toContain("archive_lookup");
  expect(provider.seen[1]).toHaveLength(15);
});

it("executes a tool call streamed by an OpenAI-compatible provider", async () => {
  const seen: unknown[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      tools?: Array<{ function: { name: string } }>;
      messages?: Array<{ role: string; content?: string }>;
    };
    seen.push(body);
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    if (seen.length === 1) {
      writeSse(response, {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_weather",
                  type: "function",
                  function: { name: "web_search", arguments: "" },
                },
              ],
            },
          },
        ],
      });
      writeSse(response, {
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, function: { arguments: '{"query":"weather"}' } }],
            },
          },
        ],
      });
      writeSse(response, { choices: [{ finish_reason: "tool_calls", delta: {} }] });
    } else {
      writeSse(response, { choices: [{ delta: { content: "It is sunny." } }] });
    }
    response.end("data: [DONE]\n\n");
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
        LLM_API_KEY: "sk-test-secret",
        LLM_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
        LLM_MODEL: "gpt-test",
      }),
      tools: createDefaultTools({}),
    });
    const response = await postChat(
      new Request("http://localhost/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "What is the weather?" }),
      }),
    );
    const events = (await readSse(response)) as SseEvent[];
    const first = seen[0] as { tools: Array<{ function: { name: string } }> };
    expect(first.tools.map((tool) => tool.function.name)).toContain("web_search");
    expect(first.tools.length).toBeLessThanOrEqual(15);
    const second = seen[1] as { messages: Array<{ role: string; content?: string }> };
    const toolMessage = second.messages.find((message) => message.role === "tool");
    expect(toolMessage?.content).toContain("weather");
    expect(JSON.stringify(seen)).not.toContain("sk-test-secret");
    expect(toolEvents(events, "tool_start").map((event) => event.data.name)).toEqual([
      "web_search",
    ]);
    expect(
      toolEvents(events, "tool_args").some((event) =>
        String(event.data.arguments).includes("weather"),
      ),
    ).toBe(true);
    expect(toolEvents(events, "tool_result")[0]?.data.status).toBe("done");
    expect(deltas(events)).toBe("It is sunny.");
  } finally {
    server.close();
  }
});

function stub(name: string): ToolDefinition {
  return {
    name,
    description: `Helper ${name}`,
    approval: "never",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async invoke() {
      return { content: name };
    },
  };
}

function writeSse(response: ServerResponse, payload: unknown): void {
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}
