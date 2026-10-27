import { afterEach, expect, it } from "vitest";
import { AgentDirectory } from "../src/agents/directory";
import type { LlmProvider } from "../src/llm";
import { MockProvider } from "../src/llm";
import { RoutineStore } from "../src/routines/store";
import { ROUTINE_LEASE_MS, tick } from "../src/routines/worker";
import { ConversationStore } from "../src/store";
import type { LlmMessage, LlmStreamEvent } from "../src/types";

const openStores: ConversationStore[] = [];

afterEach(async () => {
  await Promise.all(openStores.splice(0).map((store) => store.close()));
});

async function open() {
  const store = await ConversationStore.open();
  openStores.push(store);
  const agents = await AgentDirectory.attach(store);
  const routines = await RoutineStore.attach(store);
  return { store, agents, routines };
}

function fixedClock(at: Date) {
  let current = at;
  return {
    now: () => new Date(current.getTime()),
    set: (next: Date) => {
      current = next;
    },
  };
}

it("runs a routine with its target agent's instructions, memory note, and grants", async () => {
  const { store, agents, routines } = await open();
  const { agent } = await agents.createWithGrants({
    name: "Scout",
    instructions: "You are Scout. Report trail conditions only.",
    memoryNote: "Prefers metric units",
    connectorId: "weather",
  });
  const now = new Date("2026-10-25T21:00:00.000Z");
  const routine = await routines.create({
    name: "Trail check",
    prompt: "Check the ridge",
    eventName: "dawn",
    agentId: agent.id,
    now,
  });
  await routines.recordEvent({ name: "dawn", now });

  const seen: LlmMessage[][] = [];
  const provider: LlmProvider = {
    id: "mock",
    model: null,
    async *stream(messages: LlmMessage[]): AsyncIterable<LlmStreamEvent> {
      seen.push(messages.map((message) => ({ ...message })));
      yield { type: "text", text: "Ridge is clear." };
      yield { type: "end", finishReason: "stop" };
    },
  };
  const result = await tick({
    routines,
    store,
    provider,
    agents,
    clock: fixedClock(now),
    workerId: "worker-a",
  });
  expect(result).toEqual({ claimed: 1, succeeded: 1, failed: 0 });

  const system = seen[0]?.find((message) => message.role === "system")?.content ?? "";
  expect(system).toContain("You are Scout. Report trail conditions only.");
  expect(system).toContain("note: Prefers metric units");
  expect(system).toContain("connectors: weather");
  const saved = await routines.get(routine.id);
  const thread = await store.getConversation(saved!.conversationId!);
  expect(thread?.conversation.agentId).toBe(agent.id);
});

it("fails a routine whose model stream stalls past the timeout", async () => {
  const { store, agents, routines } = await open();
  const now = new Date("2026-10-25T21:00:00.000Z");
  const routine = await routines.create({
    name: "Stuck",
    prompt: "Hang",
    eventName: "go",
    now,
  });
  await routines.recordEvent({ name: "go", now });
  const stalled: LlmProvider = {
    id: "mock",
    model: null,
    async *stream(): AsyncIterable<LlmStreamEvent> {
      yield { type: "text", text: "partial" };
      await new Promise(() => {});
    },
  };

  const result = await tick({
    routines,
    store,
    provider: stalled,
    agents,
    clock: fixedClock(now),
    workerId: "worker-a",
    streamTimeoutMs: 50,
  });
  expect(result).toEqual({ claimed: 1, succeeded: 0, failed: 1 });
  const [run] = await routines.listRuns(routine.id);
  expect(run?.status).toBe("failed");
  expect(run?.error).toMatch(/timed out/);
});

it("does not let one stalled run block another routine in the same tick", async () => {
  const { store, agents, routines } = await open();
  const now = new Date("2026-10-25T21:00:00.000Z");
  const slow = await routines.create({ name: "Slow", prompt: "slow", eventName: "go", now });
  const fast = await routines.create({ name: "Fast", prompt: "fast", eventName: "go", now });
  await routines.recordEvent({ name: "go", now });

  let fastDone: () => void = () => {};
  const fastFinished = new Promise<void>((resolve) => {
    fastDone = resolve;
  });
  const provider: LlmProvider = {
    id: "mock",
    model: null,
    async *stream(messages: LlmMessage[]): AsyncIterable<LlmStreamEvent> {
      const prompt = messages.at(-1)?.content;
      // The slow run waits until the fast one has streamed, which needs two lanes.
      if (prompt?.startsWith("slow")) await fastFinished;
      yield { type: "text", text: `${prompt} done` };
      yield { type: "end", finishReason: "stop" };
      if (prompt?.startsWith("fast")) fastDone();
    },
  };
  // Both routines share the lead's thread, so give the fast one its own agent.
  const other = await agents.create({ name: "Other", instructions: "Other agent." });
  await store.connection.query("UPDATE routines SET agent_id = $1 WHERE id = $2", [
    other.id,
    fast.id,
  ]);

  const result = await tick({
    routines,
    store,
    provider,
    agents,
    clock: fixedClock(now),
    workerId: "worker-a",
    concurrency: 2,
  });
  expect(result).toEqual({ claimed: 2, succeeded: 2, failed: 0 });
  expect((await routines.listRuns(slow.id))[0]?.status).toBe("succeeded");
  expect((await routines.listRuns(fast.id))[0]?.status).toBe("succeeded");
});

it("fails a run whose worker died once its lease expires", async () => {
  const { store, agents, routines } = await open();
  const now = new Date("2026-10-25T21:00:00.000Z");
  const routine = await routines.create({ name: "Orphan", prompt: "Hi", eventName: "go", now });
  await routines.recordEvent({ name: "go", now });
  const claimed = await routines.claimNext("worker-dead", now);
  expect(claimed?.run.status).toBe("running");

  const clock = fixedClock(new Date(now.getTime() + ROUTINE_LEASE_MS - 1_000));
  const early = await tick({
    routines,
    store,
    provider: new MockProvider({ delayMs: 0, reply: () => "unused" }),
    agents,
    clock,
    workerId: "worker-b",
  });
  expect(early.claimed).toBe(0);
  expect((await routines.listRuns(routine.id))[0]?.status).toBe("running");

  clock.set(new Date(now.getTime() + ROUTINE_LEASE_MS + 1_000));
  await tick({
    routines,
    store,
    provider: new MockProvider({ delayMs: 0, reply: () => "unused" }),
    agents,
    clock,
    workerId: "worker-b",
  });
  const [run] = await routines.listRuns(routine.id);
  expect(run?.status).toBe("failed");
  expect(run?.error).toMatch(/abandoned/);

  const late = await routines.finishRun(claimed!.run.id, "worker-dead", {
    status: "succeeded",
    finishedAt: clock.now(),
    conversationId: null,
    assistantMessageId: null,
    error: null,
  });
  expect(late).toBe(false);
  expect((await routines.listRuns(routine.id))[0]?.status).toBe("failed");
});
