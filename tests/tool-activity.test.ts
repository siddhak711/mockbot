import { afterEach, expect, it } from "vitest";
import { POST as postChat } from "../app/api/chat/route";
import { POST as postApproval } from "../app/api/tools/approvals/route";
import { toolActivity } from "../src/chat";
import { DEFAULT_AGENT_ID } from "../src/agent";
import { resetAppContext, setAppContext } from "../src/context";
import type { LlmProvider } from "../src/llm";
import { SseParser } from "../src/sse";
import { ConversationStore } from "../src/store";
import { toToolActivity } from "../src/tools/display";
import { createMemoryTools } from "../src/tools/memory";
import type { LlmStreamEvent } from "../src/types";

it("labels each memory tool failure instead of calling every error a blocked write", () => {
  const forgotten = toolActivity(
    { id: "1", name: "memory_delete", output: "No memory with that key is stored.", isError: true },
    "done",
  );
  expect(forgotten.title).toBe("Could not forget that memory");
  expect(forgotten.title).not.toMatch(/write blocked/i);

  const searched = toolActivity(
    { id: "2", name: "memory_search", output: "sk-test-1234567890abcdefghij", isError: false },
    "done",
  );
  expect(searched.title).toBe("Searching memory");
  expect(searched.detail).not.toContain("sk-test");
  expect(searched.detail).not.toMatch(/not stored/i);

  const blocked = toolActivity(
    {
      id: "3",
      name: "memory_write",
      output: "Blocked. The text looks like a secret (openai_key) and was not stored.",
      isError: true,
      blocked: "secret",
    },
    "done",
  );
  expect(blocked.title).toBe("Memory write blocked");
  expect(blocked.detail).toBe("Blocked. A secret was not stored.");
  expect(blocked.detail).not.toContain("openai_key");

  const updated = toolActivity(
    { id: "4", name: "memory_update", output: "No memory with that key is stored.", isError: true },
    "done",
  );
  expect(updated.title).toBe("Could not update that memory");
});

const openStores: ConversationStore[] = [];

afterEach(async () => {
  await resetAppContext();
  await Promise.all(openStores.splice(0).map((store) => store.close()));
});

it("titles a failed memory search, update, and delete on the live tool result", async () => {
  const store = await ConversationStore.open();
  let turn = 0;
  const provider: LlmProvider = {
    id: "mock",
    model: null,
    async *stream(): AsyncIterable<LlmStreamEvent> {
      turn += 1;
      if (turn > 1) {
        yield { type: "text", text: "Done." };
        yield { type: "end", finishReason: "stop" };
        return;
      }
      yield {
        type: "tool_call",
        index: 0,
        id: "call_search",
        name: "memory_search",
        arguments: JSON.stringify({ query: "" }),
      };
      yield {
        type: "tool_call",
        index: 1,
        id: "call_update",
        name: "memory_update",
        arguments: JSON.stringify({ key: "missing", text: "nope" }),
      };
      yield {
        type: "tool_call",
        index: 2,
        id: "call_delete",
        name: "memory_delete",
        arguments: JSON.stringify({ key: "missing" }),
      };
      yield { type: "end", finishReason: "tool_calls" };
    },
  };
  setAppContext({ store, provider });

  const response = await postChat(
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Update the missing note to nope" }),
    }),
  );
  const pending = await readUntil(response, "approval_required");
  const approval = pending.events.find((event) => event.event === "approval_required");
  expect(approval?.data.name).toBe("memory_delete");
  const decision = await postApproval(
    new Request("http://localhost/api/tools/approvals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: approval?.data.id, decision: "approve" }),
    }),
  );
  expect(decision.status).toBe(200);
  const rest = await readRest(pending.reader, pending.parser, pending.decoder);
  const results = [...pending.events, ...rest].filter((event) => event.event === "tool_result");
  const titleFor = (name: string) => results.find((event) => event.data.name === name)?.data.title;
  expect(titleFor("memory_search")).toBe("Memory search failed");
  expect(titleFor("memory_update")).toBe("Could not update that memory");
  expect(titleFor("memory_delete")).toBe("Could not forget that memory");
});

it("keeps a failed memory search title when the computer pane reloads the call", () => {
  const activity = toToolActivity({
    id: "1",
    conversationId: "c",
    messageId: "m",
    name: "memory_search",
    arguments: JSON.stringify({ query: "blue" }),
    status: "error",
    output: "Memory tools are not available for this turn.",
    createdAt: "2026-10-25T00:00:00.000Z",
  });
  expect(activity.title).toBe("Memory search failed");
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

it("saves a memory whose key and text contain secret without labeling it blocked", async () => {
  const store = await ConversationStore.open();
  openStores.push(store);
  const text = "the secret project is named aurora and is not stored in the other notebook";
  const tools = createMemoryTools(store);
  const write = tools.find((tool) => tool.name === "memory_write");
  if (!write) throw new Error("memory_write is missing");
  const saved = await write.invoke(
    { key: "secret project", text, kind: "fact" },
    {
      memory: {
        agentId: DEFAULT_AGENT_ID,
        conversationId: "conversation",
        sourceMessageId: null,
        userMessages: [`Remember that ${text}`],
        toolOutputs: [],
      },
    },
  );
  expect(saved.isError).toBeUndefined();
  expect(saved.blocked).toBeUndefined();
  expect(saved.content).toContain("secret project");

  const activity = toolActivity(
    {
      id: "saved",
      name: "memory_write",
      output: saved.content,
      isError: false,
    },
    "done",
  );
  expect(activity.title).toBe("Saving a memory");
  expect(activity.detail).toContain("secret project");
  expect(activity.title).not.toMatch(/blocked/i);

  const live = await store.memories.listLive(DEFAULT_AGENT_ID);
  expect(live.map((memory) => [memory.key, memory.content])).toEqual([["secret project", text]]);
});
