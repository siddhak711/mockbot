import { afterEach, expect, it } from "vitest";
import { POST as postChat } from "../app/api/chat/route";
import { GET as readConversation } from "../app/api/conversations/[id]/route";
import { POST as postAsk } from "../app/api/tools/asks/route";
import { resetAppContext, setAppContext } from "../src/context";
import { MockProvider } from "../src/llm";
import { SseParser } from "../src/sse";
import { ConversationStore } from "../src/store";
import { AskGate, parseAskUser } from "../src/tools/ask-user";
import { activitiesFromMessages } from "../src/tools/display";
import type { StoredToolCall } from "../src/types";
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
