import { afterEach, expect, it } from "vitest";
import { POST } from "../app/api/chat/route";
import { POST as postApproval } from "../app/api/tools/approvals/route";
import { buildMockReply, MockProvider, selectProvider, type LlmProvider } from "../src/llm";
import { resetAppContext, setAppContext } from "../src/context";
import { withFreshTools } from "../src/mcp/sync";
import { SseParser } from "../src/sse";
import { ConversationStore } from "../src/store";
import { createDefaultTools } from "../src/tools/builtins";
import type { LlmMessage, LlmStreamEvent } from "../src/types";
import { deltas, readSse } from "./helpers";

afterEach(async () => {
  await resetAppContext();
});

it("streams a mock reply when no API key is configured", async () => {
  const provider = selectProvider({ MOCK_STREAM_DELAY_MS: "0", MOCK_CHUNK_SIZE: "16" });
  expect(provider.id).toBe("mock");
  const store = await ConversationStore.open();
  setAppContext({ store, provider });

  const response = await POST(
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Say hello" }),
    }),
  );

  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  const events = await readSse(response);
  expect(events.map((event) => event.event)).toContain("meta");
  expect(events.at(-1)?.event).toBe("done");
  expect(deltas(events)).toBe(buildMockReply("Say hello"));

  const listed = await store.listConversations();
  expect(listed).toHaveLength(1);
  expect(listed[0]?.title).toBe("Say hello");
  const loaded = await store.getConversation(listed[0]!.id);
  expect(loaded?.messages.map((message) => [message.role, message.content])).toEqual([
    ["user", "Say hello"],
    ["assistant", buildMockReply("Say hello")],
  ]);
  const raw = JSON.stringify(events);
  expect(raw).not.toContain("LLM_API_KEY");
});

it("appends a later turn to the same conversation", async () => {
  const store = await ConversationStore.open();
  setAppContext({
    store,
    provider: new MockProvider({ delayMs: 0, chunkSize: 32, reply: () => "Second reply" }),
  });
  const conversation = await store.createConversation("Existing");
  await store.addMessage(conversation.id, "user", "First");
  await store.addMessage(conversation.id, "assistant", "Earlier");

  const response = await POST(
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Next", conversationId: conversation.id }),
    }),
  );
  const events = await readSse(response);
  const meta = events.find((event) => event.event === "meta");
  expect((meta?.data as { conversationId: string }).conversationId).toBe(conversation.id);
  expect(deltas(events)).toBe("Second reply");

  const loaded = await store.getConversation(conversation.id);
  expect(loaded?.messages.map((message) => message.content)).toEqual([
    "First",
    "Earlier",
    "Next",
    "Second reply",
  ]);
});

it("rejects an empty message and an unknown conversation", async () => {
  const store = await ConversationStore.open();
  setAppContext({ store, provider: new MockProvider({ delayMs: 0 }) });

  const empty = await POST(
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "   " }),
    }),
  );
  expect(empty.status).toBe(400);

  const missing = await POST(
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Hi", conversationId: "missing" }),
    }),
  );
  expect(missing.status).toBe(404);
  expect(await store.listConversations()).toEqual([]);
});

it("does not keep the turn lock after an unread event stream finishes", async () => {
  const store = await ConversationStore.open();
  setAppContext({ store, provider: new MockProvider({ delayMs: 0 }) });

  const first = await POST(
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Say hello" }),
    }),
  );
  expect(first.status).toBe(200);
  expect(first.headers.get("content-type")).toContain("text/event-stream");

  const second = await POST(
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "   " }),
    }),
  );
  expect(second.status).toBe(400);
  await first.body?.cancel();
});

it("releases the refresh lock before the event stream finishes", async () => {
  let releaseProducer: () => void = () => undefined;
  const producerDone = new Promise<void>((resolve) => {
    releaseProducer = resolve;
  });
  const response = await withFreshTools(async () => {
    const stream = new ReadableStream({
      async start(controller) {
        await producerDone;
        controller.enqueue(new TextEncoder().encode("data: hi\n\n"));
        controller.close();
      },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream" } });
  });

  const next = await withFreshTools(async () => Response.json({ ok: true }));
  expect(next.status).toBe(200);
  releaseProducer();
  await response.body?.cancel();
});

it("finishes a second conversation while the first waits on approval", async () => {
  const tools = createDefaultTools({});
  tools.register({
    name: "send_note",
    description: "Send a note. Requires approval.",
    approval: "always",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async invoke() {
      return { content: "sent" };
    },
  });
  const store = await ConversationStore.open();
  setAppContext({ store, provider: new ApprovalProvider(), tools });

  const waiting = await POST(
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Wait for approval" }),
    }),
  );
  const pending = await readUntil(waiting, "approval_required");
  expect(pending.events.some((event) => event.data.name === "send_note")).toBe(true);

  const other = await POST(
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Say hello" }),
    }),
  );
  const finished = await readSse(other);
  expect(deltas(finished)).toBe("Other conversation finished.");
  expect(finished.at(-1)?.event).toBe("done");

  const approvalId = String(
    pending.events.find((event) => event.event === "approval_required")?.data.id,
  );
  const decision = await postApproval(
    new Request("http://localhost/api/tools/approvals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: approvalId, decision: "approve" }),
    }),
  );
  expect(decision.status).toBe(200);
  const rest = await readRest(pending.reader, pending.parser, pending.decoder);
  expect(rest.some((event) => event.event === "done")).toBe(true);
});

it("releases the turn lock when preparing a turn throws", async () => {
  await expect(
    withFreshTools(async () => {
      throw new Error("boom");
    }),
  ).rejects.toThrow("boom");
  const response = await withFreshTools(async () => Response.json({ ok: true }));
  expect(response.status).toBe(200);
});

class ApprovalProvider implements LlmProvider {
  readonly id = "mock" as const;
  readonly model = null;

  async *stream(messages: LlmMessage[]): AsyncIterable<LlmStreamEvent> {
    if (messages.some((message) => message.role === "tool")) {
      yield { type: "text", text: "Approved." };
      yield { type: "end", finishReason: "stop" };
      return;
    }
    const user = [...messages].reverse().find((message) => message.role === "user");
    const text = typeof user?.content === "string" ? user.content : "";
    if (text.startsWith("Wait")) {
      yield {
        type: "tool_call",
        index: 0,
        id: "call_send",
        name: "send_note",
        arguments: "{}",
      };
      yield { type: "end", finishReason: "tool_calls" };
      return;
    }
    yield { type: "text", text: "Other conversation finished." };
    yield { type: "end", finishReason: "stop" };
  }
}

async function readUntil(response: Response, eventName: string) {
  if (!response.body) throw new Error("Expected a response body");
  const parser = new SseParser();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const message of parser.push(decoder.decode(value, { stream: true }))) {
      const event = {
        event: message.event,
        data: JSON.parse(message.data) as Record<string, unknown>,
      };
      events.push(event);
      if (event.event === eventName) return { events, reader, parser, decoder };
    }
  }
  throw new Error(`Stream ended before ${eventName}`);
}

async function readRest(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  parser: SseParser,
  decoder: TextDecoder,
) {
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
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
