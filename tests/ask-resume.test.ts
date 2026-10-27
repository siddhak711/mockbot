import { afterEach, expect, it, vi } from "vitest";
import { POST as postChat } from "../app/api/chat/route";
import { POST as postApproval } from "../app/api/tools/approvals/route";
import { POST as postAsk } from "../app/api/tools/asks/route";
import { CONVERSATION_BUSY } from "../src/chat";
import { resetAppContext, setAppContext } from "../src/context";
import { MockProvider, streamOptions, type LlmProvider } from "../src/llm";
import { SseParser } from "../src/sse";
import { ConversationStore } from "../src/store";
import { AskGate } from "../src/tools/ask-user";
import { createDefaultTools } from "../src/tools/builtins";
import { resumeProgress } from "../src/tools/display";
import { registerMemoryTools } from "../src/tools/registry";
import type { ToolDefinition } from "../src/tools/types";
import { toolCallById } from "./helpers";
import type { LlmMessage, Message, StoredToolCall } from "../src/types";

// One test per review issue on the ask_user resume path (PR #37).

afterEach(() => {
  vi.restoreAllMocks();
  resetAppContext();
});

const ASK = {
  name: "ask_user",
  arguments: JSON.stringify({ question: "Continue?", options: ["Yes"], allowCustom: false }),
};

it("keeps polling a resumed turn until its trace ends, not when text first appears", () => {
  const ask = storedTool({ id: "ask-1", name: "ask_user", status: "done", output: "Yes" });
  const message = assistant([ask], { text: "Let me check first.", ended: false });
  expect(resumeProgress([message], "ask-1")).toBe("running");

  const ended = assistant([ask], { text: "Done.", ended: true });
  expect(resumeProgress([ended], "ask-1")).toBe("done");

  const send = storedTool({ id: "send-1", name: "send_note", status: "approval" });
  const paused = assistant([ask, send], { text: "Let me check first.", ended: false });
  expect(resumeProgress([paused], "ask-1")).toBe("paused");
});

it("refuses a new message while a stored answer is still resuming the turn", async () => {
  const store = await ConversationStore.open();
  const tools = createDefaultTools({});
  let release!: () => void;
  let entered!: () => void;
  const inside = new Promise<void>((resolve) => (entered = resolve));
  tools.register(
    tool("slow_read", "never", async () => {
      entered();
      await new Promise<void>((resolve) => (release = resolve));
      return { content: "read" };
    }),
  );
  const provider = scripted((messages) =>
    toolResults(messages) === 0 ? [ASK] : toolResults(messages) === 1 ? [call("slow_read")] : [],
  );
  const started = await startAsk(store, provider, tools);

  const answering = answer(started.id, "Yes");
  await inside;
  const blocked = await sendMessage(started.conversationId, "Another thing");
  expect(blocked.status).toBe(409);
  expect(((await blocked.json()) as { error: string }).error).toContain("still finishing");

  release();
  expect((await answering).status).toBe(200);
  const after = await sendMessage(started.conversationId, "Another thing");
  expect(after.status).toBe(200);
  await after.body?.cancel();
});

it("lets only one answer continue a question whose live turn is still waiting", async () => {
  const store = await ConversationStore.open();
  let followUps = 0;
  const provider = scripted((messages) => {
    if (toolResults(messages) === 0) return [ASK];
    followUps += 1;
    return [];
  });
  setAppContext({ store, provider, tools: createDefaultTools({}), asks: new AskGate(5_000) });
  const response = await postChat(chatRequest({ message: "Ask whether to continue" }));
  const live = await readUntil(response, "ask_user");
  const id = String(live.events.find((event) => event.event === "ask_user")?.data.id);

  const [first, second] = await Promise.all([answer(id, "Yes"), answer(id, "Yes")]);
  expect([first.status, second.status].sort()).toEqual([200, 404]);
  await readRest(live);
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(followUps).toBe(1);
  expect((await toolCallById(store, id))?.status).toBe("done");
});

it("appends a resumed turn's new tools instead of merging them into the paused ones", async () => {
  const store = await ConversationStore.open();
  const tools = createDefaultTools({});
  tools.register(tool("read_note", "never", async () => ({ content: "Noted" })));
  // Both rounds reuse index 0 and id call_0, the shape that used to collide.
  const provider = scripted((messages) =>
    toolResults(messages) === 0 ? [ASK] : toolResults(messages) === 1 ? [call("read_note")] : [],
  );
  const started = await startAsk(store, provider, tools);
  expect((await answer(started.id, "Yes")).status).toBe(200);

  const message = await lastAssistant(store, started.conversationId);
  const traced = message.trace?.tools ?? [];
  expect(traced.map((item) => item.name)).toEqual(["ask_user", "read_note"]);
  expect(new Set(traced.map((item) => item.id)).size).toBe(2);
  expect(new Set(traced.map((item) => item.index)).size).toBe(2);
  expect(traced[0]?.result).toBe("Yes");
  expect(JSON.parse(traced[0]?.arguments ?? "{}")).toMatchObject({ question: "Continue?" });
  expect(traced[1]?.result).toBe("Noted");
  expect(message.trace?.ended).toBe(true);
});

it("pauses a resumed turn's write tool for approval and stores its prepared arguments", async () => {
  const store = await ConversationStore.open();
  let ran = false;
  const tools = createDefaultTools({});
  tools.register(tool("send_note", "always", async () => ((ran = true), { content: "sent" })));
  const provider = scripted((messages) =>
    toolResults(messages) === 0 ? [ASK] : toolResults(messages) === 1 ? [sendNote()] : [],
  );
  const started = await startAsk(store, provider, tools);
  const decision = (await (await answer(started.id, "Yes")).json()) as { state?: string };
  expect(decision.state).toBe("paused");

  const send = (await rowsOf(store, started.conversationId)).find((r) => r.name === "send_note");
  expect(send?.status).toBe("approval");
  expect(JSON.parse(send?.arguments ?? "{}")).toEqual({ body: "hello" });
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(ran).toBe(false);
  await stopApproval(send?.id ?? "");
});

it("continues a resumed turn when its follow-up approval is approved, denied, or stopped", async () => {
  for (const decision of ["approve", "deny", "stop"] as const) {
    const store = await ConversationStore.open();
    let ran = false;
    const tools = createDefaultTools({});
    tools.register(tool("send_note", "always", async () => ((ran = true), { content: "sent" })));
    const provider = scripted((messages) =>
      toolResults(messages) === 0 ? [ASK] : toolResults(messages) === 1 ? [sendNote()] : [],
    );
    const started = await startAsk(store, provider, tools);
    await answer(started.id, "Yes");
    const send = (await rowsOf(store, started.conversationId)).find((r) => r.name === "send_note");

    const settled = await postApproval(
      jsonRequest("http://localhost/api/tools/approvals", { id: send?.id, decision }),
    );
    expect(settled.status).toBe(200);
    const row = await waitFor(async () => {
      const next = await toolCallById(store, send?.id ?? "");
      return next && next.status !== "approval" && next.status !== "running" ? next : null;
    });
    expect(row.status).toBe(
      decision === "approve" ? "done" : decision === "deny" ? "denied" : "error",
    );
    expect(ran).toBe(decision === "approve");
    if (decision !== "stop") {
      const message = await waitFor(async () => {
        const last = await lastAssistant(store, started.conversationId);
        return last.trace?.ended ? last : null;
      });
      expect(message.trace?.ended).toBe(true);
    }
  }
}, 30_000);

it("resumes with the turn's earlier tools, the agent prompt, and compacted history", async () => {
  const store = await ConversationStore.open();
  const tools = createDefaultTools({});
  tools.register(tool("read_note", "never", async () => ({ content: "Note body 42" })));
  const inputs: LlmMessage[][] = [];
  const provider = scripted(
    (messages) => {
      const done = toolResults(messages);
      return done === 0 ? [call("read_note")] : done === 1 ? [ASK] : [];
    },
    (messages) => inputs.push(messages),
  );
  const started = await startAsk(store, provider, tools);
  const before = inputs.length;
  expect((await answer(started.id, "Yes")).status).toBe(200);
  const lastInput = inputs[before] ?? [];

  expect(lastInput[0]?.role).toBe("system");
  const calls = lastInput.flatMap((message) => message.tool_calls ?? []);
  expect(calls.map((item) => item.function.name)).toEqual(["read_note", "ask_user"]);
  const results = lastInput.filter((message) => message.role === "tool").map((m) => m.content);
  expect(results).toEqual(["Note body 42", "Yes"]);
  expect(lastInput.some((m) => m.role === "user" && m.content === "Ask whether to continue")).toBe(
    true,
  );
});

it("gives a resumed turn the live turn's memory deps and speaker tools", async () => {
  const store = await ConversationStore.open();
  const tools = createDefaultTools({});
  registerMemoryTools(tools, store);
  const offered: string[][] = [];
  const provider = scripted(
    (messages) =>
      toolResults(messages) === 0
        ? [ASK]
        : toolResults(messages) === 1
          ? [{ name: "memory_write", arguments: JSON.stringify({ key: "plan", text: "continue" }) }]
          : [],
    undefined,
    (names) => offered.push(names),
  );
  const started = await startAsk(store, provider, tools);
  offered.length = 0;
  expect((await answer(started.id, "Yes")).status).toBe(200);

  expect(offered[0]).toContain("delegate");
  const write = (await rowsOf(store, started.conversationId)).find(
    (row) => row.name === "memory_write",
  );
  expect(write?.status).toBe("done");
  expect(write?.output).toContain('Saved memory "plan"');
});

it("drops connector tools another user's turn registered before resuming", async () => {
  const store = await ConversationStore.open();
  const tools = createDefaultTools({});
  let staleRan = false;
  // A connector tool whose closure was listed for some other signed-in user.
  tools.register(
    tool("mcp_other_user_send", "never", async () => ((staleRan = true), { content: "leaked" })),
    "mcp",
  );
  const offered: string[][] = [];
  const provider = scripted(
    (messages) =>
      toolResults(messages) === 0
        ? [ASK]
        : toolResults(messages) === 1
          ? [{ name: "mcp_other_user_send", arguments: JSON.stringify({ body: "hi" }) }]
          : [],
    undefined,
    (names) => offered.push(names),
  );
  const started = await startAsk(store, provider, tools);
  offered.length = 0;
  expect((await answer(started.id, "Yes")).status).toBe(200);

  expect(offered[0]).toContain("ask_user");
  expect(offered[0]).not.toContain("mcp_other_user_send");
  expect(staleRan).toBe(false);
});

it("blocks a new turn while a stored question with no live waiter is open", async () => {
  const store = await ConversationStore.open();
  const started = await startAsk(
    store,
    scripted(() => [ASK]),
    createDefaultTools({}),
  );
  expect((await toolCallById(store, started.id))?.status).toBe("ask");

  const blocked = await sendMessage(started.conversationId, "Never mind, do this instead");
  expect(blocked.status).toBe(409);
  expect(((await blocked.json()) as { error: string }).error).toContain("waiting for an answer");
});

it("locks the conversation before claiming, so a new turn cannot slip in before the resume", async () => {
  const store = await ConversationStore.open();
  const started = await startAsk(
    store,
    scripted(() => [ASK]),
    createDefaultTools({}),
  );
  // Hold the answer right after its claim lands, before the resume starts.
  let claimedNow!: () => void;
  const claimLanded = new Promise<void>((resolve) => (claimedNow = resolve));
  let resumeNow!: () => void;
  const hold = new Promise<void>((resolve) => (resumeNow = resolve));
  const claim = store.claimToolCall.bind(store);
  vi.spyOn(store, "claimToolCall").mockImplementation(async (...args) => {
    const row = await claim(...args);
    claimedNow();
    await hold;
    return row;
  });

  const answering = answer(started.id, "Yes");
  await claimLanded;
  expect((await toolCallById(store, started.id))?.status).toBe("done");
  const raced = await sendMessage(started.conversationId, "Something else");
  expect(raced.status).toBe(409);
  expect(((await raced.json()) as { error: string }).error).toBe(CONVERSATION_BUSY);

  resumeNow();
  expect((await answering).status).toBe(200);
  const users = (await store.getConversation(started.conversationId))?.messages.filter(
    (message) => message.role === "user",
  );
  expect(users?.map((message) => message.content)).toEqual(["Ask whether to continue"]);
});

it("refuses an answer without claiming it while a new turn is starting", async () => {
  const store = await ConversationStore.open();
  const started = await startAsk(
    store,
    scripted(() => [ASK]),
    createDefaultTools({}),
  );
  // Hold a new turn inside its start checks, while it holds the lock.
  let checking!: () => void;
  const inCheck = new Promise<void>((resolve) => (checking = resolve));
  let finishCheck!: () => void;
  const hold = new Promise<void>((resolve) => (finishCheck = resolve));
  const hasOpenAsk = store.hasOpenAsk.bind(store);
  vi.spyOn(store, "hasOpenAsk").mockImplementation(async (id) => {
    checking();
    await hold;
    return hasOpenAsk(id);
  });

  const turn = sendMessage(started.conversationId, "Something else");
  await inCheck;
  const answered = await answer(started.id, "Yes");
  expect(answered.status).toBe(409);
  expect(((await answered.json()) as { error: string }).error).toBe(CONVERSATION_BUSY);
  // The claim never ran, so the question can still be answered.
  expect((await toolCallById(store, started.id))?.status).toBe("ask");

  finishCheck();
  expect((await turn).status).toBe(409);
  vi.restoreAllMocks();
  expect((await answer(started.id, "Yes")).status).toBe(200);
});

it("ends a failed resume's trace so the client unlocks the composer", async () => {
  const store = await ConversationStore.open();
  const tools = createDefaultTools({});
  const inner = scripted(() => [ASK]);
  let failFollowUp = false;
  const provider = {
    id: inner.id,
    model: inner.model,
    stream(messages, input) {
      if (failFollowUp) throw new Error("upstream unavailable");
      return inner.stream(messages, input);
    },
  } as LlmProvider;
  const started = await startAsk(store, provider, tools);
  failFollowUp = true;

  const response = await answer(started.id, "Yes");
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ state: "error", error: "upstream unavailable" });

  const loaded = await store.getConversation(started.conversationId);
  const message = await lastAssistant(store, started.conversationId);
  expect(message.trace?.ended).toBe(true);
  expect(message.trace?.finishReason).toBe("error");
  expect(resumeProgress(loaded?.messages ?? [], started.id)).toBe("done");
  // The lock is released too: the next message runs.
  failFollowUp = false;
  const next = await sendMessage(started.conversationId, "Try again");
  expect(next.status).toBe(200);
  await next.body?.cancel();
});

// Helpers

type SseEvent = { event: string; data: Record<string, unknown> };
type Script = (messages: LlmMessage[]) => Array<{ id?: string; name: string; arguments: string }>;

function scripted(
  tools: Script,
  onMessages?: (messages: LlmMessage[]) => void,
  onTools?: (names: string[]) => void,
): LlmProvider {
  const inner = new MockProvider({ delayMs: 0, tools, onMessages });
  return {
    id: inner.id,
    model: inner.model,
    stream(messages, input) {
      onTools?.((streamOptions(input).tools ?? []).map((item) => item.name));
      return inner.stream(messages, input);
    },
  } as LlmProvider;
}

function toolResults(messages: LlmMessage[]): number {
  return messages.filter((message) => message.role === "tool").length;
}

function call(name: string) {
  return { name, arguments: JSON.stringify({ body: "x" }) };
}

function sendNote() {
  return { name: "send_note", arguments: JSON.stringify({ body: "  hello  " }) };
}

function tool(
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

function storedTool(overrides: Partial<StoredToolCall>): StoredToolCall {
  return {
    id: "tool",
    conversationId: "c1",
    messageId: "m1",
    name: "ask_user",
    arguments: ASK.arguments,
    status: "done",
    output: null,
    createdAt: new Date(0).toISOString(),
    ...overrides,
  } as StoredToolCall;
}

function assistant(tools: StoredToolCall[], trace: { text: string; ended: boolean }): Message {
  return {
    id: "m1",
    conversationId: "c1",
    role: "assistant",
    content: trace.text,
    createdAt: new Date(0).toISOString(),
    tools,
    trace: {
      started: true,
      role: "assistant",
      reasoning: "",
      tools: [],
      text: trace.text,
      finishReason: trace.ended ? "stop" : null,
      ended: trace.ended,
    },
  };
}

function jsonRequest(url: string, body: unknown, signal?: AbortSignal): Request {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
}

function chatRequest(body: Record<string, unknown>, signal?: AbortSignal): Request {
  return jsonRequest("http://localhost/api/chat", body, signal);
}

function answer(id: string, text: string): Promise<Response> {
  return postAsk(jsonRequest("http://localhost/api/tools/asks", { id, answer: text }));
}

function sendMessage(conversationId: string, message: string): Promise<Response> {
  return postChat(chatRequest({ conversationId, message }));
}

async function stopApproval(id: string): Promise<void> {
  await postApproval(jsonRequest("http://localhost/api/tools/approvals", { id, decision: "stop" }));
}

async function rowsOf(store: ConversationStore, conversationId: string) {
  const loaded = await store.getConversation(conversationId);
  return loaded?.messages.flatMap((message) => message.tools ?? []) ?? [];
}

async function lastAssistant(store: ConversationStore, conversationId: string): Promise<Message> {
  const loaded = await store.getConversation(conversationId);
  const message = loaded?.messages.filter((item) => item.role === "assistant").at(-1);
  if (!message) throw new Error("Expected an assistant message");
  return message;
}

async function waitFor<T>(check: () => Promise<T | null>): Promise<T> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting");
}

/** Start a turn that pauses on ask_user, then drop the live waiter. */
async function startAsk(
  store: ConversationStore,
  provider: LlmProvider,
  tools: ReturnType<typeof createDefaultTools>,
) {
  const controller = new AbortController();
  setAppContext({ store, provider, tools, asks: new AskGate(300) });
  const response = await postChat(
    chatRequest({ message: "Ask whether to continue" }, controller.signal),
  );
  const pending = await readUntil(response, "ask_user");
  const asked = pending.events.filter((event) => event.event === "ask_user").at(-1);
  const id = String(asked?.data.id);
  const conversationId = String(
    pending.events.find((event) => event.event === "meta")?.data.conversationId,
  );
  controller.abort();
  await pending.reader.cancel().catch(() => undefined);
  setAppContext({ store, provider, tools, asks: new AskGate() });
  return { id, conversationId };
}

type Stream = {
  events: SseEvent[];
  reader: ReadableStreamDefaultReader<Uint8Array>;
  parser: SseParser;
  decoder: TextDecoder;
};

async function readUntil(response: Response, eventName: string): Promise<Stream> {
  if (!response.body) throw new Error("Expected a response body");
  const stream: Stream = {
    events: [],
    reader: response.body.getReader(),
    parser: new SseParser(),
    decoder: new TextDecoder(),
  };
  while (true) {
    const { done, value } = await stream.reader.read();
    if (done) break;
    for (const message of stream.parser.push(stream.decoder.decode(value, { stream: true }))) {
      const event = { event: message.event, data: JSON.parse(message.data) as SseEvent["data"] };
      stream.events.push(event);
      if (event.event === eventName) return stream;
    }
  }
  throw new Error(`Stream ended before ${eventName}`);
}

async function readRest(stream: Stream): Promise<void> {
  while (!(await stream.reader.read()).done) {
    // Drain the live turn.
  }
}
