import { afterEach, expect, it } from "vitest";
import { POST as signInPassword } from "../app/api/auth/password/route";
import { PATCH } from "../app/api/routines/[id]/route";
import { POST as postEvent } from "../app/api/routines/events/route";
import { GET, POST } from "../app/api/routines/route";
import { AgentDirectory } from "../src/agents/directory";
import { resetAppContext, setAppContext } from "../src/context";
import { MockProvider } from "../src/llm";
import { RoutineStore } from "../src/routines/store";
import type { Routine, RoutineRun } from "../src/routines/types";
import { tick } from "../src/routines/worker";
import { ConversationStore } from "../src/store";

const originalRequireAuth = process.env.MOCKBOT_REQUIRE_AUTH;

afterEach(async () => {
  if (originalRequireAuth === undefined) delete process.env.MOCKBOT_REQUIRE_AUTH;
  else process.env.MOCKBOT_REQUIRE_AUTH = originalRequireAuth;
  await resetAppContext();
});

function passwordRequest(body: Record<string, string>): Request {
  return new Request("http://localhost:3000/api/auth/password", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function cookiePair(setCookie: string | null): string {
  const match = setCookie?.match(/authjs\.session-token=([^;]+)/);
  if (!match?.[1]) throw new Error(`Missing session cookie: ${setCookie}`);
  const name = setCookie?.includes("__Secure-authjs.session-token=")
    ? "__Secure-authjs.session-token"
    : "authjs.session-token";
  return `${name}=${match[1]}`;
}

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

it("keeps a routine on its owner's thread and hides it from another account", async () => {
  process.env.MOCKBOT_REQUIRE_AUTH = "1";
  const store = await ConversationStore.open();
  await AgentDirectory.attach(store);
  const routines = await RoutineStore.attach(store);
  setAppContext({
    store,
    routines,
    provider: new MockProvider({ delayMs: 0, chunkSize: 40, reply: () => "From Bea" }),
  });

  const adaSignup = await signInPassword(
    passwordRequest({
      intent: "sign-up",
      name: "Ada",
      email: "ada@example.com",
      password: "ada password value",
    }),
  );
  const beaSignup = await signInPassword(
    passwordRequest({
      intent: "sign-up",
      name: "Bea",
      email: "bea@example.com",
      password: "bea password value",
    }),
  );
  expect(adaSignup.status).toBe(200);
  expect(beaSignup.status).toBe(200);
  const adaCookie = cookiePair(adaSignup.headers.get("set-cookie"));
  const beaCookie = cookiePair(beaSignup.headers.get("set-cookie"));
  const adaId = ((await adaSignup.json()) as { user: { id: string } }).user.id;
  const beaId = ((await beaSignup.json()) as { user: { id: string } }).user.id;

  const adaList = await GET(
    new Request("http://localhost/api/routines", { headers: { cookie: adaCookie } }),
  );
  expect(adaList.status).toBe(200);

  const created = await POST(
    new Request("http://localhost/api/routines", {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: beaCookie },
      body: JSON.stringify({
        name: "Bea deploy",
        prompt: "Record Bea's deploy",
        eventName: "deploy.finished",
      }),
    }),
  );
  expect(created.status).toBe(201);
  const { routine } = (await created.json()) as { routine: Routine };
  expect(routine.userId).toBe(beaId);
  expect(routine.agentId).toBe(`lead_${beaId}`);

  const hidden = await GET(
    new Request("http://localhost/api/routines", { headers: { cookie: adaCookie } }),
  );
  const hiddenPage = (await hidden.json()) as { routines: Routine[] };
  expect(hiddenPage.routines).toEqual([]);

  const paused = await PATCH(
    new Request(`http://localhost/api/routines/${routine.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", cookie: adaCookie },
      body: JSON.stringify({ status: "paused" }),
    }),
    { params: Promise.resolve({ id: routine.id }) },
  );
  expect(paused.status).toBe(404);
  expect((await routines.get(routine.id))?.status).toBe("active");

  const owned = await postEvent(
    new Request("http://localhost/api/routines/events", {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: beaCookie },
      body: JSON.stringify({ name: "deploy.finished" }),
    }),
  );
  expect(owned.status).toBe(201);
  expect(((await owned.json()) as { runs: RoutineRun[] }).runs).toHaveLength(1);

  const crossed = await postEvent(
    new Request("http://localhost/api/routines/events", {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: adaCookie },
      body: JSON.stringify({ name: "deploy.finished" }),
    }),
  );
  expect(crossed.status).toBe(201);
  expect(((await crossed.json()) as { runs: RoutineRun[] }).runs).toEqual([]);
  expect(await routines.listRuns(routine.id)).toHaveLength(1);

  const now = new Date(Date.now() + 60_000);
  await tick({
    routines,
    store,
    provider: new MockProvider({ delayMs: 0, chunkSize: 20, reply: () => "From Bea" }),
    clock: { now: () => now },
    workerId: "isolation",
  });

  const runs = await routines.listRuns(routine.id);
  expect(runs.map((run) => run.status)).toEqual(["succeeded"]);
  const conversationId = runs[0]?.conversationId;
  expect(conversationId).toBeTruthy();
  const owner = await store.connection.query<{ user_id: string | null; agent_id: string }>(
    `SELECT user_id, agent_id FROM conversations WHERE id = $1`,
    [conversationId],
  );
  expect(owner.rows[0]).toEqual({ user_id: beaId, agent_id: `lead_${beaId}` });
  const loaded = await store.getConversation(conversationId!);
  expect(loaded?.messages.map((message) => message.content)).toEqual([
    "Record Bea's deploy",
    "From Bea",
  ]);

  const elsewhere = await store.connection.query<{ id: string }>(
    `SELECT conversations.id
     FROM conversations
     JOIN messages ON messages.conversation_id = conversations.id
     WHERE messages.content = $1
       AND (conversations.user_id IS DISTINCT FROM $2 OR conversations.agent_id <> $3)`,
    ["Record Bea's deploy", beaId, `lead_${beaId}`],
  );
  expect(elsewhere.rows).toEqual([]);
  const adaThread = await store.getOrCreateAgentConversation("agent_default", adaId);
  const adaMessages = await store.getConversation(adaThread.id);
  expect(adaMessages?.messages ?? []).toEqual([]);
});
