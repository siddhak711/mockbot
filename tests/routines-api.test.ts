import { afterEach, expect, it } from "vitest";
import { PATCH } from "../app/api/routines/[id]/route";
import { POST as postEvent } from "../app/api/routines/events/route";
import { GET, POST } from "../app/api/routines/route";
import { resetAppContext, setAppContext } from "../src/context";
import { MockProvider } from "../src/llm";
import { RoutineStore } from "../src/routines/store";
import type { Routine, RoutineRun } from "../src/routines/types";
import { tick } from "../src/routines/worker";
import { ConversationStore } from "../src/store";

afterEach(async () => {
  await resetAppContext();
});

async function context(): Promise<{ store: ConversationStore; routines: RoutineStore }> {
  const store = await ConversationStore.open();
  const routines = await RoutineStore.attach(store);
  setAppContext({
    store,
    routines,
    provider: new MockProvider({ delayMs: 0, chunkSize: 40, reply: () => "From the worker" }),
  });
  return { store, routines };
}

it("creates a cron routine through the API and returns the next run time", async () => {
  await context();
  const before = Date.now();
  const response = await POST(
    new Request("http://localhost/api/routines", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Hourly",
        prompt: "Check the inbox",
        cron: "0 * * * *",
      }),
    }),
  );
  expect(response.status).toBe(201);
  const body = (await response.json()) as { routine: Routine };
  expect(body.routine.nextRunAt).toBeTruthy();
  const next = new Date(body.routine.nextRunAt!).getTime();
  expect(next).toBeGreaterThan(before);
  expect(new Date(body.routine.nextRunAt!).getUTCMinutes()).toBe(0);

  const listed = await GET();
  const page = (await listed.json()) as { routines: Array<Routine & { runs: RoutineRun[] }> };
  expect(page.routines.map((routine) => routine.name)).toEqual(["Hourly"]);
  expect(page.routines[0]?.nextRunAt).toBe(body.routine.nextRunAt);
  expect(page.routines[0]?.runs).toEqual([]);
});

it("rejects an invalid schedule and pauses from the API", async () => {
  const { routines } = await context();
  const invalid = await POST(
    new Request("http://localhost/api/routines", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Bad", prompt: "Nope", cron: "tomorrow" }),
    }),
  );
  expect(invalid.status).toBe(400);

  const created = await POST(
    new Request("http://localhost/api/routines", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Ok", prompt: "Go", cron: "* * * * *" }),
    }),
  );
  const { routine } = (await created.json()) as { routine: Routine };
  const paused = await PATCH(
    new Request("http://localhost/api/routines/" + routine.id, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "paused" }),
    }),
    { params: Promise.resolve({ id: routine.id }) },
  );
  expect(paused.status).toBe(200);
  expect((await routines.get(routine.id))?.status).toBe("paused");

  const missing = await PATCH(
    new Request("http://localhost/api/routines/missing", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "active" }),
    }),
    { params: Promise.resolve({ id: "missing" }) },
  );
  expect(missing.status).toBe(404);
});

it("schedules one run when an event is inserted", async () => {
  const { store, routines } = await context();
  const created = await POST(
    new Request("http://localhost/api/routines", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Deploy note",
        prompt: "Record the deploy",
        eventName: "deploy.finished",
      }),
    }),
  );
  expect(created.status).toBe(201);
  const { routine } = (await created.json()) as { routine: Routine };
  expect(routine.nextRunAt).toBeNull();

  const event = await postEvent(
    new Request("http://localhost/api/routines/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "deploy.finished" }),
    }),
  );
  expect(event.status).toBe(201);
  const body = (await event.json()) as { runs: RoutineRun[] };
  expect(body.runs).toHaveLength(1);

  const now = new Date();
  await tick({
    routines,
    store,
    provider: new MockProvider({ delayMs: 0, chunkSize: 20, reply: () => "From the worker" }),
    clock: { now: () => now },
    workerId: "api-test",
  });
  const runs = await routines.listRuns(routine.id);
  expect(runs.map((run) => run.status)).toEqual(["succeeded"]);
  const loaded = await store.getConversation(runs[0]!.conversationId!);
  expect(loaded?.messages.map((message) => message.content)).toEqual([
    "Record the deploy",
    "From the worker",
  ]);
});
