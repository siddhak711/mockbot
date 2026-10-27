import { afterEach, expect, it } from "vitest";
import { POST as postChat } from "../app/api/chat/route";
import { GET as readConversation } from "../app/api/conversations/[id]/route";
import { POST as postAsk } from "../app/api/tools/asks/route";
import { resetAppContext, setAppContext } from "../src/context";
import { streamChatTurn } from "../src/chat";
import { MockProvider } from "../src/llm";
import { runRoutineTurn } from "../src/routines/turn";
import { SseParser } from "../src/sse";
import { ConversationStore } from "../src/store";
import { ApprovalGate } from "../src/tools/approval";
import { AskGate, ASK_UNATTENDED, parseAskUser } from "../src/tools/ask-user";
import { createDefaultTools } from "../src/tools/builtins";
import { activitiesFromMessages } from "../src/tools/display";
import type { ToolDefinition } from "../src/tools/types";
import type { LlmMessage, LlmStreamEvent, StoredToolCall } from "../src/types";
import { deltas } from "./helpers";

afterEach(async () => {
  await resetAppContext();
});

it("requires a question and at least one way to answer", () => {
  expect(parseAskUser({})).toMatchObject({ ok: false });
  expect(parseAskUser({ question: "Pick one", options: [] })).toMatchObject({ ok: false });
  expect(parseAskUser({ question: "Pick one", options: ["Blue"] })).toMatchObject({
    ok: true,
    request: { question: "Pick one", options: ["Blue"], allowCustom: false },
  });
  expect(
    parseAskUser({ question: "  Pick one  ", options: [" Blue ", "Blue", ""], allowCustom: true }),
  ).toMatchObject({
    ok: true,
    request: { question: "Pick one", options: ["Blue"], allowCustom: true },
  });
});

it("pauses ask_user until the chosen option is the tool result", async () => {
  const store = await ConversationStore.open();
  setAppContext({ store, provider: new MockProvider({ delayMs: 0 }) });
  const response = await postChat(
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message:
          'Call ask_user {"question":"Which color?","options":["Blue","Red"],"allowCustom":true}',
      }),
    }),
  );
  const pending = await readUntil(response, "ask_user");
  const ask = pending.events.find((event) => event.event === "ask_user");
  expect(ask?.data.question).toBe("Which color?");
  expect(ask?.data.options).toEqual(["Blue", "Red"]);
  expect(ask?.data.allowCustom).toBe(true);
  expect(pending.events.some((event) => event.event === "done")).toBe(false);

  const conversationId = String(
    pending.events.find((event) => event.event === "meta")?.data.conversationId,
  );
  const blocked = await postChat(
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Another turn", conversationId }),
    }),
  );
  expect(blocked.status).toBe(409);

  const rejected = await postAsk(
    new Request("http://localhost/api/tools/asks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: ask?.data.id, answer: "Green" }),
    }),
  );
  expect(rejected.status).toBe(200);

  const rest = await readRest(pending.reader, pending.parser, pending.decoder);
  const events = [...pending.events, ...rest];
  const result = events.find(
    (event) => event.event === "tool_result" && event.data.name === "ask_user",
  );
  expect(result?.data.status).toBe("done");
  expect(result?.data.output).toBe("Green");
  expect(deltas(events)).toContain("Green");
  expect(events.at(-1)?.event).toBe("done");
});

it("rejects a typed answer when allowCustom is false", async () => {
  const store = await ConversationStore.open();
  setAppContext({ store, provider: new MockProvider({ delayMs: 0 }) });
  const response = await postChat(
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: 'Call ask_user {"question":"Which color?","options":["Blue","Red"]}',
      }),
    }),
  );
  const pending = await readUntil(response, "ask_user");
  const id = String(pending.events.find((event) => event.event === "ask_user")?.data.id);
  const rejected = await postAsk(
    new Request("http://localhost/api/tools/asks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, answer: "Green" }),
    }),
  );
  expect(rejected.status).toBe(400);
  const accepted = await postAsk(
    new Request("http://localhost/api/tools/asks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, answer: "Blue" }),
    }),
  );
  expect(accepted.status).toBe(200);
  await readRest(pending.reader, pending.parser, pending.decoder);
});

it("restores a pending question after the client disconnects and resumes when it is answered", async () => {
  const store = await ConversationStore.open();
  setAppContext({ store, provider: new MockProvider({ delayMs: 0 }) });
  const controller = new AbortController();
  const response = await postChat(
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        message: 'Call ask_user {"question":"Ship it?","options":["Yes","No"],"allowCustom":false}',
      }),
    }),
  );
  const pending = await readUntil(response, "ask_user");
  const id = String(pending.events.find((event) => event.event === "ask_user")?.data.id);
  controller.abort();
  await pending.reader.cancel().catch(() => undefined);

  const conversationId = (await store.listConversations())[0]!.id;
  const loaded = await readConversation(new Request("http://localhost"), {
    params: Promise.resolve({ id: conversationId }),
  });
  const body = (await loaded.json()) as {
    messages: Array<{
      role: string;
      content: string;
      tools?: Array<{ id: string; name: string; status: string; arguments: string }>;
    }>;
  };
  const assistant = body.messages.find((message) => message.role === "assistant");
  const tool = assistant?.tools?.find((item) => item.id === id);
  expect(tool?.status).toBe("ask");
  expect(tool?.arguments).toContain("Ship it?");
  const restored = activitiesFromMessages([
    {
      tools: (assistant?.tools ?? []).map(
        (tool) =>
          ({
            ...tool,
            conversationId,
            messageId: "message",
            output: null,
            createdAt: "",
          }) as StoredToolCall,
      ),
    },
  ]);
  expect(restored.find((item) => item.id === id)?.state).toBe("ask");

  const decision = await postAsk(
    new Request("http://localhost/api/tools/asks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, answer: "Yes" }),
    }),
  );
  expect(decision.status).toBe(200);

  let status = tool?.status;
  let content = assistant?.content ?? "";
  for (
    let attempt = 0;
    attempt < 40 && (status !== "done" || !content.includes("Yes"));
    attempt += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    const again = await store.getConversation(conversationId);
    const message = again?.messages.find((item) => item.role === "assistant");
    status = message?.tools?.find((item) => item.id === id)?.status;
    content = message?.content ?? "";
  }
  expect(status).toBe("done");
  expect(content).toContain("Yes");
});

it("resumes a stored question after the in-memory waiter is gone", async () => {
  const store = await ConversationStore.open();
  const controller = new AbortController();
  setAppContext({
    store,
    provider: new MockProvider({ delayMs: 0 }),
    asks: new AskGate(300),
  });
  const response = await postChat(
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        message: 'Call ask_user {"question":"Ship it?","options":["Yes","No"],"allowCustom":false}',
      }),
    }),
  );
  const pending = await readUntil(response, "ask_user");
  const id = String(pending.events.find((event) => event.event === "ask_user")?.data.id);
  const conversationId = String(
    pending.events.find((event) => event.event === "meta")?.data.conversationId,
  );
  controller.abort();
  await pending.reader.cancel().catch(() => undefined);

  setAppContext({
    store,
    provider: new MockProvider({ delayMs: 0 }),
    asks: new AskGate(),
  });
  const decision = await postAsk(
    new Request("http://localhost/api/tools/asks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, answer: "Yes" }),
    }),
  );
  expect(decision.status).toBe(200);
  const payload = (await decision.json()) as { resumed?: boolean; answer?: string };
  expect(payload.resumed).toBe(true);
  expect(payload.answer).toBe("Yes");

  const loaded = await store.getConversation(conversationId);
  const message = loaded?.messages.find((item) => item.role === "assistant");
  const tool = message?.tools?.find((item) => item.id === id);
  expect(tool?.status).toBe("done");
  expect(tool?.output).toBe("Yes");
  expect(message?.content).toContain("Yes");

  await new Promise((resolve) => setTimeout(resolve, 500));
  const again = await store.getConversation(conversationId);
  const settled = again?.messages.find((item) => item.role === "assistant");
  expect(settled?.tools?.find((item) => item.id === id)?.status).toBe("done");
  expect(settled?.content).toContain("Yes");
  expect(settled?.content).not.toContain("did not answer");
});

it("does not run an approval-required tool while resuming a stored ask", async () => {
  const store = await ConversationStore.open();
  let ran = false;
  const tools = createDefaultTools({});
  tools.register(
    recordingTool(
      "send_note",
      "always",
      ranFlag(() => (ran = true)),
    ),
  );
  const provider = new MockProvider({
    delayMs: 0,
    tools: followAskWith("send_note", { body: "  hello  " }),
  });
  const started = await startAsk(store, provider, tools);
  const decision = await postAsk(
    new Request("http://localhost/api/tools/asks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: started.id, answer: "Yes" }),
    }),
  );
  expect(decision.status).toBe(200);
  const send = (await store.getConversation(started.conversationId))?.messages
    .flatMap((message) => message.tools ?? [])
    .find((tool) => tool.name === "send_note");
  const rows = (await store.getConversation(started.conversationId))?.messages.flatMap(
    (message) => message.tools ?? [],
  );
  const ask = rows?.find((tool) => tool.id === started.id);
  expect(ask?.status).toBe("done");
  expect(ask?.output).toBe("Yes");
  expect(ran).toBe(false);
  expect(send?.status).toBe("approval");
  expect(send?.output).toBeNull();
  expect(JSON.parse(send?.arguments ?? "{}")).toEqual({ body: "hello" });
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(ran).toBe(false);
  expect((await store.getToolCall(send?.id ?? ""))?.status).toBe("approval");
});

it("still runs a follow-up tool that does not need approval after a stored ask resumes", async () => {
  const store = await ConversationStore.open();
  let ran = false;
  const tools = createDefaultTools({});
  tools.register(
    recordingTool("read_note", "never", async (args) => {
      ran = true;
      return { content: `Noted ${String(args.body)}` };
    }),
  );
  const provider = new MockProvider({
    delayMs: 0,
    tools: followAskWith("read_note", { body: "  hello  " }),
  });
  const started = await startAsk(store, provider, tools);
  const decision = await postAsk(
    new Request("http://localhost/api/tools/asks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: started.id, answer: "Yes" }),
    }),
  );
  expect(decision.status).toBe(200);
  const follow = (await store.getConversation(started.conversationId))?.messages
    .flatMap((message) => message.tools ?? [])
    .find((tool) => tool.name === "read_note");
  expect(ran).toBe(true);
  expect(follow?.status).toBe("done");
  expect(follow?.output).toBe("Noted hello");
});

it("expires a stored question that can no longer be read", async () => {
  const store = await ConversationStore.open();
  setAppContext({
    store,
    provider: new MockProvider({ delayMs: 0 }),
    asks: new AskGate(300),
  });
  const response = await postChat(
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: 'Call ask_user {"question":"Ship it?","options":["Yes"],"allowCustom":false}',
      }),
    }),
  );
  const pending = await readUntil(response, "ask_user");
  const id = String(pending.events.find((event) => event.event === "ask_user")?.data.id);
  await store.connection.query(`UPDATE tool_calls SET arguments = $2 WHERE id = $1`, [id, "{"]);
  setAppContext({
    store,
    provider: new MockProvider({ delayMs: 0 }),
    asks: new AskGate(),
  });
  const decision = await postAsk(
    new Request("http://localhost/api/tools/asks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, answer: "Yes" }),
    }),
  );
  expect(decision.status).toBe(404);
  expect((await store.getToolCall(id))?.status).toBe("error");
  await pending.reader.cancel().catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect((await store.getToolCall(id))?.status).toBe("error");
});

it("does not wait for ask_user when the turn has nobody watching", async () => {
  const store = await ConversationStore.open();
  setAppContext({ store, provider: new MockProvider({ delayMs: 0 }) });
  const started = Date.now();
  const response = await streamChatTurn({
    store,
    provider: new MockProvider({ delayMs: 0 }),
    tools: createDefaultTools({}),
    approvals: new ApprovalGate(60_000),
    asks: new AskGate(60_000),
    unattended: true,
    message: 'Call ask_user {"question":"Go?","options":["Yes"],"allowCustom":false}',
  });
  const events = await readSse(response);
  expect(Date.now() - started).toBeLessThan(1_000);
  const result = events.find(
    (event) => event.event === "tool_result" && event.data.name === "ask_user",
  );
  expect(result?.data.status).toBe("error");
  expect(String(result?.data.output)).toContain("nobody to ask");
  expect(events.some((event) => event.event === "ask_user")).toBe(false);
  expect(events.at(-1)?.event).toBe("done");
});

it("finishes a routine that tries to ask_user without waiting for a person", async () => {
  const store = await ConversationStore.open();
  setAppContext({ store, provider: new MockProvider({ delayMs: 0 }) });
  const conversation = await store.createConversation("Routine");
  const started = Date.now();
  const turn = await runRoutineTurn({
    store,
    provider: {
      id: "mock",
      model: null,
      async *stream(): AsyncIterable<LlmStreamEvent> {
        yield {
          type: "tool_call",
          index: 0,
          id: "call_ask",
          name: "ask_user",
          arguments: JSON.stringify({
            question: "Go?",
            options: ["Yes"],
            allowCustom: false,
          }),
        };
        yield { type: "end", finishReason: "tool_calls" };
      },
    },
    conversationId: conversation.id,
    prompt: "Ask whether to go",
  });
  expect(Date.now() - started).toBeLessThan(1_000);
  expect(turn.text).toBe(ASK_UNATTENDED);
  const loaded = await store.getConversation(conversation.id);
  const tools = loaded?.messages.flatMap((message) => message.tools ?? []) ?? [];
  expect(tools.some((tool) => tool.status === "ask")).toBe(false);
});

it("ends a pending question on stop and times out when nobody answers", async () => {
  const store = await ConversationStore.open();
  setAppContext({
    store,
    provider: new MockProvider({ delayMs: 0 }),
    asks: new AskGate(30),
  });
  const response = await postChat(
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: 'Call ask_user {"question":"Still there?","options":["Yes"],"allowCustom":false}',
      }),
    }),
  );
  const events = await readSse(response);
  const result = events.find(
    (event) => event.event === "tool_result" && event.data.name === "ask_user",
  );
  expect(result?.data.status).toBe("error");
  expect(String(result?.data.output)).toContain("did not answer");
  expect(events.at(-1)?.event).toBe("done");
});

type SseEvent = { event: string; data: Record<string, unknown> };

async function startAsk(
  store: ConversationStore,
  provider: MockProvider,
  tools: ReturnType<typeof createDefaultTools>,
) {
  const controller = new AbortController();
  setAppContext({ store, provider, tools, asks: new AskGate(300) });
  const response = await postChat(
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({ message: "Ask whether to continue" }),
    }),
  );
  const pending = await readUntil(response, "ask_user");
  const id = String(pending.events.find((event) => event.event === "ask_user")?.data.id);
  const conversationId = String(
    pending.events.find((event) => event.event === "meta")?.data.conversationId,
  );
  controller.abort();
  await pending.reader.cancel().catch(() => undefined);
  setAppContext({ store, provider, tools, asks: new AskGate() });
  return { id, conversationId };
}

function followAskWith(
  name: string,
  args: Record<string, unknown>,
): (messages: LlmMessage[]) => Array<{ name: string; arguments: string }> {
  return (messages) => {
    if (messages.some((message) => message.role === "tool")) {
      return [{ name, arguments: JSON.stringify(args) }];
    }
    return [
      {
        name: "ask_user",
        arguments: JSON.stringify({
          question: "Continue?",
          options: ["Yes"],
          allowCustom: false,
        }),
      },
    ];
  };
}

function recordingTool(
  name: string,
  approval: "always" | "never",
  invoke: ToolDefinition["invoke"],
): ToolDefinition {
  return {
    name,
    description: name,
    approval,
    skipHeuristicApproval: approval === "never",
    inputSchema: {
      type: "object",
      properties: { body: { type: "string" } },
      additionalProperties: false,
    },
    prepare(args) {
      const body = typeof args.body === "string" ? args.body.trim() : "";
      if (!body) return { error: `${name} requires a body.` };
      return { args: { body } };
    },
    invoke,
  };
}

function ranFlag(mark: () => void): ToolDefinition["invoke"] {
  return async () => {
    mark();
    return { content: "sent" };
  };
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

async function readSse(response: Response): Promise<SseEvent[]> {
  if (!response.body) throw new Error("Expected a response body");
  const parser = new SseParser();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
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
