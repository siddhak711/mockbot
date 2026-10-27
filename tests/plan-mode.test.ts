import { afterEach, expect, it } from "vitest";
import { POST as postChat } from "../app/api/chat/route";
import { GET as readConversation } from "../app/api/conversations/[id]/route";
import { POST as postPlan } from "../app/api/tools/plans/route";
import { streamChatTurn } from "../src/chat";
import { resetAppContext, setAppContext } from "../src/context";
import { MockProvider, type LlmProvider } from "../src/llm";
import { SseParser } from "../src/sse";
import { ConversationStore } from "../src/store";
import { ApprovalGate } from "../src/tools/approval";
import { AskGate } from "../src/tools/ask-user";
import { createDefaultTools } from "../src/tools/builtins";
import { activitiesFromMessages } from "../src/tools/display";
import { PlanGate, PLAN_UNATTENDED } from "../src/tools/plan";
import type { LlmMessage, LlmStreamEvent, StoredToolCall } from "../src/types";
import { deltas, listConversations, readSse } from "./helpers";

afterEach(async () => {
  await resetAppContext();
});

const BIG_TASK = [
  '1. Search — Call web_search {"query":"later"}',
  "2. Fetch — Open the page",
  "3. Summarize — Write the recap",
].join("\n");

it("does not run tools or another model turn before a big task is approved", async () => {
  const provider = new EarlyToolProvider();
  const store = await ConversationStore.open();
  setAppContext({ store, provider });
  const response = await postChat(
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Ship the three-part change" }),
    }),
  );
  const pending = await readUntil(response, "plan_required");
  expect(provider.calls).toBe(1);
  expect(pending.events.some((event) => event.event === "tool_start")).toBe(false);
  expect(pending.events.filter((event) => event.event === "start")).toHaveLength(1);
  expect(deltas(pending.events)).not.toContain("Finished:");
  const steps = pending.events.find((event) => event.event === "plan_required")?.data.steps;
  expect(Array.isArray(steps)).toBe(true);

  const id = String(pending.events.find((event) => event.event === "plan_required")?.data.id);
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

  const decision = await postPlan(
    new Request("http://localhost/api/tools/plans", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, decision: "approve" }),
    }),
  );
  expect(decision.status).toBe(200);
  const rest = await readRest(pending.reader, pending.parser, pending.decoder);
  const events = [...pending.events, ...rest];
  const executed = events.filter(
    (event) =>
      event.event === "tool_start" || event.event === "tool_args" || event.event === "tool_result",
  );
  expect(executed.some((event) => event.data.name === "web_search")).toBe(false);
  expect(executed.some((event) => JSON.stringify(event.data).includes("early"))).toBe(false);
  expect(deltas(events)).toContain("Finished: Search");
  expect(deltas(events)).toContain("Finished: Summarize");
  expect(events.at(-1)?.event).toBe("done");
  expect(provider.calls).toBe(4);
});

it("does not run a delegate emitted in the same round as a self-proposed plan", async () => {
  const provider = new DelegateAndPlanProvider();
  const store = await ConversationStore.open();
  setAppContext({ store, provider });
  const response = await postChat(
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Hand this off and then plan the rest" }),
    }),
  );
  const pending = await readUntil(response, "plan_required");
  expect(provider.calls).toBe(1);
  expect(pending.events.some((event) => event.event === "tool_start")).toBe(false);
  expect(
    pending.events.some((event) => event.event === "tool_result" && event.data.name === "delegate"),
  ).toBe(false);
  expect(deltas(pending.events)).not.toContain("Delegated");
  expect(deltas(pending.events)).not.toContain("Finished:");

  const id = String(pending.events.find((event) => event.event === "plan_required")?.data.id);
  const cancelled = await postPlan(
    new Request("http://localhost/api/tools/plans", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, decision: "cancel" }),
    }),
  );
  expect(cancelled.status).toBe(200);
  const rest = await readRest(pending.reader, pending.parser, pending.decoder);
  const events = [...pending.events, ...rest];
  const executed = events.filter(
    (event) =>
      event.event === "tool_start" || event.event === "tool_args" || event.event === "tool_result",
  );
  expect(executed.some((event) => event.data.name === "delegate")).toBe(false);
  expect(deltas(events)).toContain("Cancelled the plan. Nothing ran.");
  expect(deltas(events)).not.toContain("Delegated");
  expect(provider.calls).toBe(1);
});

it("does not wait on a plan during an unattended turn", async () => {
  const provider = new UnattendedPlanProvider();
  const store = await ConversationStore.open();
  const plans = new PlanGate(1_000);
  const started = Date.now();
  const response = await streamChatTurn({
    store,
    provider,
    tools: createDefaultTools({}),
    approvals: new ApprovalGate(60_000),
    asks: new AskGate(60_000),
    plans,
    unattended: true,
    message: "Plan the nightly cleanup",
  });
  const events = (await readSse(response)) as SseEvent[];
  expect(Date.now() - started).toBeLessThan(1_000);
  expect(events.some((event) => event.event === "plan_required")).toBe(false);
  const conversationId = String(
    events.find((event) => event.event === "meta")?.data.conversationId,
  );
  expect(plans.hasPending(conversationId)).toBe(false);
  const result = events.find(
    (event) => event.event === "tool_result" && event.data.name === "propose_plan",
  );
  expect(result?.data.status).toBe("error");
  expect(result?.data.output).toBe(PLAN_UNATTENDED);
  expect(deltas(events)).not.toContain("Nothing ran.");
  expect(deltas(events)).not.toContain("Finished:");
  expect(provider.calls).toBe(2);
  expect(events.at(-1)?.event).toBe("done");
});

it("plans a three-step task from the mock provider before any tool starts", async () => {
  const store = await ConversationStore.open();
  setAppContext({ store, provider: new MockProvider({ delayMs: 0 }) });
  const response = await postChat(
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: BIG_TASK }),
    }),
  );
  const pending = await readUntil(response, "plan_required");
  expect(pending.events.some((event) => event.event === "tool_start")).toBe(false);
  const plan = pending.events.find((event) => event.event === "plan_required");
  expect(plan?.data.steps).toMatchObject([
    { title: "Search", detail: 'Call web_search {"query":"later"}' },
    { title: "Fetch" },
    { title: "Summarize" },
  ]);

  const id = String(plan?.data.id);
  const approved = await postPlan(
    new Request("http://localhost/api/tools/plans", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, decision: "approve" }),
    }),
  );
  expect(approved.status).toBe(200);
  const rest = await readRest(pending.reader, pending.parser, pending.decoder);
  const events = [...pending.events, ...rest];
  const starts = events.filter((event) => event.event === "tool_start");
  expect(starts.map((event) => event.data.name)).toEqual(["web_search"]);
  expect(pending.events.some((event) => event.event === "tool_start")).toBe(false);
  const progress = events.filter((event) => event.event === "plan_progress");
  const done = progress.find((event) => event.data.status === "done");
  expect(done?.data.steps).toMatchObject([
    { title: "Search", state: "done" },
    { title: "Fetch", state: "done" },
    { title: "Summarize", state: "done" },
  ]);
  expect(deltas(events)).toContain("Finished: Search");
  expect(deltas(events)).toContain("Finished: Summarize");
});

it("uses the Plan switch for a short task and runs the edited steps", async () => {
  const store = await ConversationStore.open();
  setAppContext({ store, provider: new MockProvider({ delayMs: 0 }) });
  const response = await postChat(
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Hello", plan: true }),
    }),
  );
  const pending = await readUntil(response, "plan_required");
  expect(pending.events.some((event) => event.event === "tool_start")).toBe(false);
  const id = String(pending.events.find((event) => event.event === "plan_required")?.data.id);
  const edited = await postPlan(
    new Request("http://localhost/api/tools/plans", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id,
        decision: "edit",
        steps: [
          { title: "Outline", detail: "List the points" },
          { title: "Draft", detail: "Write the note" },
          { title: "Send", detail: "Deliver the note" },
        ],
      }),
    }),
  );
  expect(edited.status).toBe(200);
  const approved = await postPlan(
    new Request("http://localhost/api/tools/plans", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, decision: "approve" }),
    }),
  );
  expect(approved.status).toBe(200);
  const rest = await readRest(pending.reader, pending.parser, pending.decoder);
  const text = deltas([...pending.events, ...rest]);
  expect(text).toContain("Finished: Outline");
  expect(text).toContain("Finished: Draft");
  expect(text).toContain("Finished: Send");
  expect(text).not.toContain("Finished: Understand the request");
});

it("cancels a plan before anything runs", async () => {
  const store = await ConversationStore.open();
  setAppContext({ store, provider: new MockProvider({ delayMs: 0 }) });
  const response = await postChat(
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: BIG_TASK }),
    }),
  );
  const pending = await readUntil(response, "plan_required");
  const id = String(pending.events.find((event) => event.event === "plan_required")?.data.id);
  const cancelled = await postPlan(
    new Request("http://localhost/api/tools/plans", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, decision: "cancel" }),
    }),
  );
  expect(cancelled.status).toBe(200);
  const rest = await readRest(pending.reader, pending.parser, pending.decoder);
  const events = [...pending.events, ...rest];
  expect(events.some((event) => event.event === "tool_start")).toBe(false);
  expect(deltas(events)).toContain("Cancelled the plan. Nothing ran.");
  expect(deltas(events)).not.toContain("Finished:");
  const result = events.find(
    (event) => event.event === "tool_result" && event.data.name === "propose_plan",
  );
  expect(result?.data.status).toBe("denied");
  expect(events.at(-1)?.event).toBe("done");
});

it("restores a pending plan after the client disconnects and resumes when it is approved", async () => {
  const store = await ConversationStore.open();
  setAppContext({ store, provider: new MockProvider({ delayMs: 0 }) });
  const controller = new AbortController();
  const response = await postChat(
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({ message: BIG_TASK }),
    }),
  );
  const pending = await readUntil(response, "plan_required");
  const id = String(pending.events.find((event) => event.event === "plan_required")?.data.id);
  const edited = await postPlan(
    new Request("http://localhost/api/tools/plans", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id,
        decision: "edit",
        steps: [
          { title: "Reload search", detail: "Look again" },
          { title: "Reload fetch", detail: "Open it again" },
          { title: "Reload summary", detail: "Write it again" },
        ],
      }),
    }),
  );
  expect(edited.status).toBe(200);
  controller.abort();
  await pending.reader.cancel().catch(() => undefined);

  const conversationId = (await listConversations(store))[0]!.id;
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
  expect(tool?.status).toBe("plan");
  expect(tool?.arguments).toContain("Reload search");
  const restored = activitiesFromMessages([
    {
      tools: (assistant?.tools ?? []).map(
        (item) =>
          ({
            ...item,
            conversationId,
            messageId: "message",
            output: null,
            createdAt: "",
          }) as StoredToolCall,
      ),
    },
  ]);
  expect(restored.find((item) => item.id === id)?.state).toBe("plan");

  const decision = await postPlan(
    new Request("http://localhost/api/tools/plans", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, decision: "approve" }),
    }),
  );
  expect(decision.status).toBe(200);

  let status = tool?.status;
  let content = assistant?.content ?? "";
  let argumentsText = tool?.arguments ?? "";
  for (
    let attempt = 0;
    attempt < 40 && (status !== "done" || !content.includes("Reload summary"));
    attempt += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    const again = await store.getConversation(conversationId);
    const message = again?.messages.find((item) => item.role === "assistant");
    const stored = message?.tools?.find((item) => item.id === id);
    status = stored?.status;
    argumentsText = stored?.arguments ?? "";
    content = message?.content ?? "";
  }
  expect(status).toBe("done");
  expect(content).toContain("Finished: Reload search");
  expect(content).toContain("Finished: Reload summary");
  expect(argumentsText).toContain('"state":"done"');
});

class DelegateAndPlanProvider implements LlmProvider {
  readonly id = "mock" as const;
  readonly model = null;
  calls = 0;

  async *stream(): AsyncIterable<LlmStreamEvent> {
    this.calls += 1;
    yield { type: "start", role: "assistant" };
    yield {
      type: "tool_call",
      index: 0,
      id: "call_delegate",
      name: "delegate",
      arguments: JSON.stringify({ agent: "Researcher", task: "Do it before approval" }),
    };
    yield {
      type: "tool_call",
      index: 1,
      id: "call_plan",
      name: "propose_plan",
      arguments: JSON.stringify({
        steps: [
          { title: "Search", detail: "Look it up" },
          { title: "Fetch", detail: "Open the page" },
          { title: "Summarize", detail: "Write the recap" },
        ],
      }),
    };
    yield { type: "end", finishReason: "tool_calls" };
  }
}

class UnattendedPlanProvider implements LlmProvider {
  readonly id = "mock" as const;
  readonly model = null;
  calls = 0;

  async *stream(): AsyncIterable<LlmStreamEvent> {
    this.calls += 1;
    yield { type: "start", role: "assistant" };
    if (this.calls === 1) {
      yield {
        type: "tool_call",
        index: 0,
        id: "call_plan",
        name: "propose_plan",
        arguments: JSON.stringify({
          steps: [
            { title: "Scan", detail: "Find old files" },
            { title: "Archive", detail: "Move them aside" },
            { title: "Report", detail: "Say what moved" },
          ],
        }),
      };
      yield { type: "end", finishReason: "tool_calls" };
      return;
    }
    yield { type: "text", text: "Continued without a plan." };
    yield { type: "end", finishReason: "stop" };
  }
}

class EarlyToolProvider implements LlmProvider {
  readonly id = "mock" as const;
  readonly model = null;
  calls = 0;

  async *stream(messages: LlmMessage[]): AsyncIterable<LlmStreamEvent> {
    this.calls += 1;
    const last = [...messages].reverse().find((message) => message.role === "user")?.content ?? "";
    const step = last.match(/^Execute step (\d+) only: ([^\n]*)\n([\s\S]*)$/);
    if (!step) {
      yield { type: "start", role: "assistant" };
      yield {
        type: "tool_call",
        index: 0,
        id: "call_early",
        name: "web_search",
        arguments: JSON.stringify({ query: "early" }),
      };
      yield {
        type: "tool_call",
        index: 1,
        id: "call_plan",
        name: "propose_plan",
        arguments: JSON.stringify({
          steps: [
            { title: "Search", detail: "Look it up" },
            { title: "Fetch", detail: "Open the page" },
            { title: "Summarize", detail: "Write the recap" },
          ],
        }),
      };
      yield { type: "end", finishReason: "tool_calls" };
      return;
    }
    yield { type: "start", role: "assistant" };
    yield { type: "text", text: `Finished: ${step[2]?.trim() ?? ""}\n` };
    yield { type: "end", finishReason: "stop" };
  }
}

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
