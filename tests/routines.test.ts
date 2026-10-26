import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { LlmProvider } from "../src/llm";
import { MockProvider, SYSTEM_PROMPT } from "../src/llm";
import { pollIntervalMs, shouldStartInlineWorker } from "../src/routines/clock";
import { CronError, nextCron } from "../src/routines/cron";
import { RoutineStore } from "../src/routines/store";
import { modelMessages } from "../src/routines/turn";
import { runWorker, tick } from "../src/routines/worker";
import { ConversationStore } from "../src/store";
import type { LlmMessage, LlmStreamEvent } from "../src/types";

const openStores: ConversationStore[] = [];

afterEach(async () => {
  await Promise.all(openStores.splice(0).map((store) => store.close()));
});

async function open(): Promise<{ store: ConversationStore; routines: RoutineStore }> {
  const store = await ConversationStore.open();
  openStores.push(store);
  const routines = await RoutineStore.attach(store);
  return { store, routines };
}

class FakeClock {
  constructor(private current: Date) {}

  now(): Date {
    return new Date(this.current.getTime());
  }

  set(next: Date): void {
    this.current = new Date(next.getTime());
  }
}

function reply(text: string): LlmProvider {
  return new MockProvider({ delayMs: 0, chunkSize: 80, reply: () => text });
}

const failing: LlmProvider = {
  id: "mock",
  model: null,
  async *stream(): AsyncIterable<LlmStreamEvent> {
    throw new Error("upstream unavailable");
    yield { type: "end", finishReason: "stop" };
  },
};

it("computes the next UTC cron time from a fake clock", () => {
  const sundayNoon = new Date("2026-10-25T12:00:30.000Z");
  expect(nextCron("* * * * *", sundayNoon).toISOString()).toBe("2026-10-25T12:01:00.000Z");
  expect(nextCron("*/15 * * * *", new Date("2026-10-25T21:00:00.000Z")).toISOString()).toBe(
    "2026-10-25T21:15:00.000Z",
  );
  expect(nextCron("0 9 * * 1", sundayNoon).toISOString()).toBe("2026-10-26T09:00:00.000Z");
  expect(nextCron("0 0 * * 7", new Date("2026-10-24T12:00:00.000Z")).toISOString()).toBe(
    "2026-10-25T00:00:00.000Z",
  );
  expect(nextCron("0 0 1 * 1", sundayNoon).toISOString()).toBe("2026-10-26T00:00:00.000Z");
  expect(nextCron("0 0 1 * 1", new Date("2026-10-26T00:00:00.000Z")).toISOString()).toBe(
    "2026-11-01T00:00:00.000Z",
  );
  expect(() => nextCron("60 * * * *", sundayNoon)).toThrow(CronError);
  expect(() => nextCron("* * * *", sundayNoon)).toThrow(CronError);
  expect(() => nextCron("0 0 31 2 *", sundayNoon)).toThrow(/no occurrence/);
});

it("creates a cron routine and shows the next run time", async () => {
  const { routines } = await open();
  const now = new Date("2026-10-25T21:11:40.000Z");
  const routine = await routines.create({
    name: "Morning note",
    prompt: "Summarize today",
    cron: " * * * * * ",
    now,
  });
  expect(routine.trigger).toEqual({ kind: "cron", cron: "* * * * *" });
  expect(routine.nextRunAt).toBe("2026-10-25T21:12:00.000Z");
  expect(routine.status).toBe("active");
});

it("runs a due routine without a browser session and writes the conversation", async () => {
  const { store, routines } = await open();
  const clock = new FakeClock(new Date("2026-10-25T21:11:40.000Z"));
  const routine = await routines.create({
    name: "Morning note",
    prompt: "Summarize today",
    cron: "* * * * *",
    now: clock.now(),
  });
  clock.set(new Date(routine.nextRunAt!));
  const result = await tick({
    routines,
    store,
    provider: reply("Today is clear."),
    clock,
    workerId: "worker-a",
  });
  expect(result).toEqual({ claimed: 1, succeeded: 1, failed: 0 });

  const runs = await routines.listRuns(routine.id);
  expect(runs.map((run) => run.status)).toEqual(["succeeded"]);
  expect(runs[0]?.claimedBy).toBe("worker-a");
  expect(runs[0]?.resultExcerpt).toContain("Today is clear.");

  const saved = await routines.get(routine.id);
  expect(saved?.conversationId).toBeTruthy();
  const conversation = await store.getConversation(saved!.conversationId!);
  expect(conversation?.messages.map((message) => [message.role, message.content])).toEqual([
    ["user", "Summarize today"],
    ["assistant", "Today is clear."],
  ]);

  clock.set(clock.now());
  const again = await tick({
    routines,
    store,
    provider: reply("should not run"),
    clock,
    workerId: "worker-a",
  });
  expect(again.claimed).toBe(0);
  expect(await routines.listRuns(routine.id)).toHaveLength(1);
  expect((await routines.get(routine.id))?.nextRunAt).toBe("2026-10-25T21:13:00.000Z");
});

it("pausing stops further runs and keeps the last run visible", async () => {
  const { store, routines } = await open();
  const clock = new FakeClock(new Date("2026-10-25T08:00:00.000Z"));
  const routine = await routines.create({
    name: "Digest",
    prompt: "Daily digest",
    cron: "0 * * * *",
    now: clock.now(),
  });
  expect(routine.nextRunAt).toBe("2026-10-25T09:00:00.000Z");
  clock.set(new Date("2026-10-25T09:00:00.000Z"));
  await tick({ routines, store, provider: reply("Nine"), clock, workerId: "worker-a" });
  await routines.setStatus(routine.id, "paused", clock.now());
  clock.set(new Date("2026-10-25T10:00:00.000Z"));
  const paused = await tick({
    routines,
    store,
    provider: reply("Ten"),
    clock,
    workerId: "worker-a",
  });
  expect(paused.claimed).toBe(0);
  const runs = await routines.listRuns(routine.id);
  expect(runs).toHaveLength(1);
  expect(runs[0]?.status).toBe("succeeded");
  expect(runs[0]?.resultExcerpt).toContain("Nine");
});

it("inserting a matching event runs that routine once", async () => {
  const { store, routines } = await open();
  const now = new Date("2026-10-25T21:00:00.000Z");
  const routine = await routines.create({
    name: "On deploy",
    prompt: "Note the deploy",
    eventName: "deploy.finished",
    now,
  });
  await routines.create({
    name: "Other",
    prompt: "Ignore",
    eventName: "build.finished",
    now,
  });
  const paused = await routines.create({
    name: "Paused listener",
    prompt: "Skip",
    eventName: "deploy.finished",
    now,
  });
  await routines.setStatus(paused.id, "paused", now);

  const first = await routines.recordEvent({
    name: "deploy.finished",
    payload: "v1",
    now,
  });
  expect(first.runs).toHaveLength(1);
  expect(first.runs[0]?.routineId).toBe(routine.id);

  const clock = new FakeClock(now);
  await tick({ routines, store, provider: reply("Noted v1"), clock, workerId: "worker-a" });
  await tick({ routines, store, provider: reply("again"), clock, workerId: "worker-a" });
  expect((await routines.listRuns(routine.id)).map((run) => run.status)).toEqual(["succeeded"]);

  const conversation = await store.getConversation(
    (await routines.get(routine.id))!.conversationId!,
  );
  expect(conversation?.messages[0]?.content).toBe("Note the deploy\n\nEvent deploy.finished:\nv1");
  expect(conversation?.messages[1]?.content).toBe("Noted v1");

  await routines.recordEvent({ name: "deploy.finished", now });
  await tick({ routines, store, provider: reply("Noted again"), clock, workerId: "worker-a" });
  expect(await routines.listRuns(routine.id)).toHaveLength(2);
  expect(await routines.listRuns(paused.id)).toHaveLength(0);
});

it("stores a failing run and does not spin on it", async () => {
  const { store, routines } = await open();
  const clock = new FakeClock(new Date("2026-10-25T21:00:00.000Z"));
  const routine = await routines.create({
    name: "Broken",
    prompt: "Fail please",
    cron: "* * * * *",
    now: clock.now(),
  });
  clock.set(new Date(routine.nextRunAt!));
  const failed = await tick({ routines, store, provider: failing, clock, workerId: "worker-a" });
  expect(failed).toEqual({ claimed: 1, succeeded: 0, failed: 1 });
  const again = await tick({ routines, store, provider: failing, clock, workerId: "worker-a" });
  expect(again.claimed).toBe(0);
  const runs = await routines.listRuns(routine.id);
  expect(runs).toHaveLength(1);
  expect(runs[0]?.status).toBe("failed");
  expect(runs[0]?.error).toBe("upstream unavailable");
  expect((await routines.get(routine.id))?.nextRunAt).not.toBe(routine.nextRunAt);
  const conversation = await store.getConversation(
    (await routines.get(routine.id))!.conversationId!,
  );
  expect(conversation?.messages.map((message) => [message.role, message.content])).toEqual([
    ["user", "Fail please"],
    ["assistant", "Routine failed: upstream unavailable"],
  ]);
});

it("does not send an unanswered failed prompt as the next run's history", async () => {
  const { store, routines } = await open();
  const clock = new FakeClock(new Date("2026-10-25T21:00:00.000Z"));
  const routine = await routines.create({
    name: "Broken",
    prompt: "Fail please",
    cron: "* * * * *",
    now: clock.now(),
  });
  clock.set(new Date(routine.nextRunAt!));
  await tick({ routines, store, provider: failing, clock, workerId: "worker-a" });
  const saved = await routines.get(routine.id);
  await store.addMessage(saved!.conversationId!, "user", "left unanswered");

  const seen: LlmMessage[][] = [];
  const capturing: LlmProvider = {
    id: "mock",
    model: null,
    async *stream(messages: LlmMessage[]): AsyncIterable<LlmStreamEvent> {
      seen.push(messages.map((message) => ({ ...message })));
      yield { type: "text", text: "recovered" };
      yield { type: "end", finishReason: "stop" };
    },
  };
  clock.set(new Date(saved!.nextRunAt!));
  const recovered = await tick({
    routines,
    store,
    provider: capturing,
    clock,
    workerId: "worker-a",
  });
  expect(recovered).toEqual({ claimed: 1, succeeded: 1, failed: 0 });
  expect(seen).toEqual([
    [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: "Fail please" },
      { role: "assistant", content: "Routine failed: upstream unavailable" },
      { role: "user", content: "Fail please" },
    ],
  ]);
  expect(
    modelMessages([
      { role: "user", content: "orphan" },
      { role: "user", content: "current" },
    ]),
  ).toEqual([
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: "current" },
  ]);
});

it("keeps one conversation when two runs create one together", async () => {
  const { store, routines } = await open();
  const now = new Date("2026-10-25T21:00:00.000Z");
  const routine = await routines.create({
    name: "Shared",
    prompt: "Note it",
    eventName: "shipped",
    now,
  });
  await routines.recordEvent({ name: "shipped", payload: "one", now });
  await routines.recordEvent({ name: "shipped", payload: "two", now });

  const original = store.createConversation.bind(store);
  let creates = 0;
  store.createConversation = async (title: string) => {
    const created = await original(title);
    creates += 1;
    if (creates === 1) {
      for (let turn = 0; turn < 40 && creates < 2; turn += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    }
    return created;
  };

  const clock = new FakeClock(now);
  const [first, second] = await Promise.all([
    tick({ routines, store, provider: reply("noted"), clock, workerId: "worker-a" }),
    tick({ routines, store, provider: reply("noted"), clock, workerId: "worker-b" }),
  ]);
  expect(creates).toBe(1);
  expect(first.succeeded + second.succeeded).toBe(2);
  const saved = await routines.get(routine.id);
  const runs = await routines.listRuns(routine.id);
  expect(runs).toHaveLength(2);
  expect(runs.every((run) => run.conversationId === saved?.conversationId)).toBe(true);
  const conversation = await store.getConversation(saved!.conversationId!);
  expect(
    conversation?.messages
      .filter((message) => message.role === "user")
      .map((message) => message.content)
      .sort(),
  ).toEqual(["Note it\n\nEvent shipped:\none", "Note it\n\nEvent shipped:\ntwo"]);
  store.createConversation = original;
  const later = await store.createConversation("later", "agent_other");
  expect(await routines.setConversation(routine.id, later.id, now)).toBe(saved?.conversationId);
});

it("keeps an in-flight prompt when another run shares the conversation", async () => {
  const { store, routines } = await open();
  const now = new Date("2026-10-25T21:00:00.000Z");
  const routine = await routines.create({
    name: "Shared",
    prompt: "Note it",
    eventName: "shipped",
    now,
  });
  await routines.recordEvent({ name: "shipped", payload: "one", now });
  await routines.recordEvent({ name: "shipped", payload: "two", now });

  const seen: LlmMessage[][] = [];
  let calls = 0;
  let release: () => void = () => {};
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const provider: LlmProvider = {
    id: "mock",
    model: null,
    async *stream(messages: LlmMessage[]): AsyncIterable<LlmStreamEvent> {
      seen.push(messages.map((message) => ({ ...message })));
      calls += 1;
      if (calls === 1) {
        entered();
        await hold;
      }
      yield { type: "text", text: "noted" };
      yield { type: "end", finishReason: "stop" };
    },
  };
  const clock = new FakeClock(now);
  const first = tick({ routines, store, provider, clock, workerId: "worker-a" });
  await started;
  const second = tick({ routines, store, provider, clock, workerId: "worker-b" });
  for (let turn = 0; turn < 20; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  expect(seen).toHaveLength(1);
  const livePrompt = seen[0]?.find((message) => message.role === "user")?.content;
  expect(livePrompt).toBeTruthy();
  release();
  const [leader, follower] = await Promise.all([first, second]);
  expect(leader.succeeded + follower.succeeded).toBe(2);
  const secondUsers = seen[1]
    ?.filter((message) => message.role === "user")
    .map((message) => message.content);
  expect(secondUsers?.[0]).toBe(livePrompt);
  expect(secondUsers?.[1]).toMatch(/Event shipped:/);
  expect(secondUsers?.[1]).not.toBe(livePrompt);
  expect(
    seen[1]?.some((message) => message.role === "assistant" && message.content === "noted"),
  ).toBe(true);
  expect((await routines.get(routine.id))?.conversationId).toBeTruthy();
});

it("does not skip a cron slot when a later enqueue saw the same due row", async () => {
  const { store, routines } = await open();
  const routine = await routines.create({
    name: "Hourly",
    prompt: "Ping",
    cron: "* * * * *",
    now: new Date("2026-10-25T21:00:00.000Z"),
  });
  expect(routine.nextRunAt).toBe("2026-10-25T21:01:00.000Z");
  const early = new Date("2026-10-25T21:01:10.000Z");
  const later = new Date("2026-10-25T21:02:10.000Z");
  const db = store.connection;
  const original = db.query.bind(db);
  let releaseEarly: () => void = () => {};
  const earlyGo = new Promise<void>((resolve) => {
    releaseEarly = resolve;
  });
  let earlySelected: () => void = () => {};
  const earlyReady = new Promise<void>((resolve) => {
    earlySelected = resolve;
  });
  let releaseLate: () => void = () => {};
  const lateGo = new Promise<void>((resolve) => {
    releaseLate = resolve;
  });
  let lateSelected: () => void = () => {};
  const lateReady = new Promise<void>((resolve) => {
    lateSelected = resolve;
  });
  db.query = (async (sql: string, params?: unknown[]) => {
    const result = await original(sql, params);
    if (sql.includes("ORDER BY next_run_at, id")) {
      const at = params?.[0] instanceof Date ? params[0] : new Date(String(params?.[0]));
      if (at.getTime() === early.getTime()) {
        earlySelected();
        await earlyGo;
      } else if (at.getTime() === later.getTime()) {
        lateSelected();
        await lateGo;
      }
    }
    return result;
  }) as typeof db.query;

  const earlyEnqueue = routines.enqueueDue(early);
  await earlyReady;
  const lateEnqueue = routines.enqueueDue(later);
  await lateReady;
  releaseEarly();
  expect(await earlyEnqueue).toBe(1);
  releaseLate();
  expect(await lateEnqueue).toBe(1);
  const saved = await routines.get(routine.id);
  const runs = await routines.listRuns(routine.id);
  expect(runs.map((run) => run.scheduledFor).sort()).toEqual([
    "2026-10-25T21:01:00.000Z",
    "2026-10-25T21:02:00.000Z",
  ]);
  expect(saved?.nextRunAt).toBe("2026-10-25T21:03:00.000Z");
});

it("lets only one of two workers complete a run", async () => {
  const { store, routines } = await open();
  const clock = new FakeClock(new Date("2026-10-25T21:00:00.000Z"));
  const routine = await routines.create({
    name: "Once",
    prompt: "Say once",
    cron: "* * * * *",
    now: clock.now(),
  });
  const due = new Date(routine.nextRunAt!);
  await routines.enqueueDue(due);
  const first = await routines.claimNext("worker-a", due);
  const second = await routines.claimNext("worker-b", due);
  expect(first?.run.routineId).toBe(routine.id);
  expect(second).toBeNull();
  const stolen = await routines.finishRun(first!.run.id, "worker-b", {
    status: "succeeded",
    finishedAt: due,
    conversationId: null,
    assistantMessageId: null,
    error: null,
  });
  expect(stolen).toBe(false);

  let calls = 0;
  let release: () => void = () => {};
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const blocking: LlmProvider = {
    id: "mock",
    model: null,
    async *stream(): AsyncIterable<LlmStreamEvent> {
      calls += 1;
      if (calls === 1) {
        entered();
        await hold;
      }
      yield { type: "text", text: "once" };
      yield { type: "end", finishReason: "stop" };
    },
  };

  await routines.finishRun(first!.run.id, "worker-a", {
    status: "failed",
    finishedAt: due,
    conversationId: null,
    assistantMessageId: null,
    error: "reset for the race",
  });
  const later = new Date(due.getTime() + 60_000);
  const next = await routines.get(routine.id);
  expect(next?.nextRunAt).toBe(later.toISOString());
  const raceClock = new FakeClock(later);
  const leader = tick({
    routines,
    store,
    provider: blocking,
    clock: raceClock,
    workerId: "worker-a",
  });
  await started;
  const follower = await tick({
    routines,
    store,
    provider: blocking,
    clock: raceClock,
    workerId: "worker-b",
  });
  release();
  const leaderResult = await leader;
  expect(calls).toBe(1);
  expect(follower.claimed).toBe(0);
  expect(leaderResult).toEqual({ claimed: 1, succeeded: 1, failed: 0 });
  const runs = await routines.listRuns(routine.id);
  expect(runs.filter((run) => run.status === "succeeded")).toHaveLength(1);
  expect(runs.filter((run) => run.claimedBy === "worker-b")).toHaveLength(0);
});

it("stops the worker loop when the signal aborts", async () => {
  const { store, routines } = await open();
  const clock = new FakeClock(new Date("2026-10-25T21:05:00.000Z"));
  await routines.create({
    name: "Loop",
    prompt: "Hi",
    cron: "* * * * *",
    now: new Date("2026-10-25T21:04:30.000Z"),
  });
  const controller = new AbortController();
  let ticks = 0;
  await runWorker({
    routines,
    store,
    provider: reply("done"),
    clock,
    workerId: "worker-a",
    pollMs: 60_000,
    signal: controller.signal,
    onTick: (result) => {
      ticks += 1;
      expect(result.succeeded).toBe(1);
      controller.abort();
    },
  });
  expect(ticks).toBe(1);
});

it("reopens routines from the same embedded database", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mockbot-routines-"));
  try {
    const firstStore = await ConversationStore.open(dir);
    const first = await RoutineStore.attach(firstStore);
    await RoutineStore.attach(firstStore);
    const created = await first.create({
      name: "Kept",
      prompt: "Stay",
      cron: "0 0 * * *",
      now: new Date("2026-10-25T00:00:00.000Z"),
    });
    await firstStore.close();

    const secondStore = await ConversationStore.open(dir);
    openStores.push(secondStore);
    const second = await RoutineStore.attach(secondStore);
    expect((await second.get(created.id))?.prompt).toBe("Stay");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("chooses the in-process worker only for local dev", () => {
  expect(shouldStartInlineWorker({ NODE_ENV: "development" })).toBe(true);
  expect(shouldStartInlineWorker({ NODE_ENV: "production" })).toBe(false);
  expect(shouldStartInlineWorker({ NODE_ENV: "test" })).toBe(false);
  expect(shouldStartInlineWorker({ NODE_ENV: "production", ROUTINES_WORKER: "inline" })).toBe(true);
  expect(shouldStartInlineWorker({ NODE_ENV: "development", ROUTINES_WORKER: "off" })).toBe(false);
  expect(pollIntervalMs({})).toBe(1000);
  expect(pollIntervalMs({ ROUTINE_POLL_MS: "250" })).toBe(250);
  expect(pollIntervalMs({ ROUTINE_POLL_MS: "nope" })).toBe(1000);
});
