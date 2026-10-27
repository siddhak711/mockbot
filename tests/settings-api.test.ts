import { afterEach, expect, it } from "vitest";
import { GET as listAgents, POST as createAgent } from "../app/api/agents/route";
import { DELETE as deleteAgent, PATCH as patchAgent } from "../app/api/agents/[id]/route";
import { LEAD_AGENT_ID } from "../src/agents/ids";
import { changePassword, readAccount, renameAccount } from "../src/auth/account";
import { signInWithPassword, signUpWithPassword } from "../src/auth/password";
import { readSessionUser } from "../src/auth/sessions";
import { resetAppContext, setAppContext } from "../src/context";
import { MockProvider } from "../src/llm";
import { ConversationStore } from "../src/store";

afterEach(async () => {
  await resetAppContext();
});

async function openContext(): Promise<ConversationStore> {
  const store = await ConversationStore.open();
  setAppContext({ store, provider: new MockProvider({ delayMs: 0 }) });
  return store;
}

function json(method: string, body: unknown): Request {
  return new Request("http://localhost/api/agents/x", {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

async function newAgent(name: string): Promise<string> {
  const response = await createAgent(
    json("POST", { name, instructions: `You are ${name}.`, connectorId: "calendar" }),
  );
  const body = (await response.json()) as { agent: { id: string } };
  return body.agent.id;
}

it("edits an agent's fields and replaces its grants", async () => {
  await openContext();
  const id = await newAgent("Builder");

  const saved = await patchAgent(
    json("PATCH", {
      name: "Builder Two",
      instructions: "Ship it.",
      memoryNote: "Prefers small PRs",
      computerIds: ["desk", "desk", " "],
      connectorIds: ["github"],
    }),
    params(id),
  );
  expect(saved.status).toBe(200);

  const listed = (await (await listAgents()).json()) as {
    agents: Array<{
      id: string;
      name: string;
      instructions: string;
      memoryNote: string;
      grants: Array<{ kind: string; resourceId: string }>;
    }>;
  };
  const agent = listed.agents.find((item) => item.id === id);
  expect(agent).toMatchObject({
    name: "Builder Two",
    instructions: "Ship it.",
    memoryNote: "Prefers small PRs",
  });
  expect(agent?.grants.map((grant) => `${grant.kind}:${grant.resourceId}`).sort()).toEqual([
    "computer:desk",
    "connector:github",
  ]);
});

it("refuses a duplicate name, a missing agent, and a bad grant id", async () => {
  await openContext();
  const id = await newAgent("Builder");
  await newAgent("Designer");

  const clash = await patchAgent(
    json("PATCH", { name: "designer", instructions: "x" }),
    params(id),
  );
  expect(clash.status).toBe(409);

  const missing = await patchAgent(
    json("PATCH", { name: "Ghost", instructions: "x" }),
    params("nope"),
  );
  expect(missing.status).toBe(404);

  const bad = await patchAgent(
    json("PATCH", { name: "Builder", instructions: "x", connectorIds: ["has spaces"] }),
    params(id),
  );
  expect(bad.status).toBe(400);
});

it("deletes an agent with its thread and memories, but never the lead", async () => {
  const store = await openContext();
  const id = await newAgent("Builder");
  const thread = await store.getOrCreateAgentConversation(id, null);
  await store.addMessage(thread.id, "user", "hello");
  await store.connection.query(
    `INSERT INTO memories (id, agent_id, kind, key, content, created_by)
     VALUES ('m1', $1, 'fact', 'k', 'v', 'test')`,
    [id],
  );

  const lead = await deleteAgent(
    new Request("http://localhost", { method: "DELETE" }),
    params(LEAD_AGENT_ID),
  );
  expect(lead.status).toBe(400);

  const removed = await deleteAgent(
    new Request("http://localhost", { method: "DELETE" }),
    params(id),
  );
  expect(removed.status).toBe(204);

  const left = await store.connection.query<{ n: number }>(
    `SELECT
       (SELECT COUNT(*) FROM agents WHERE id = $1)::int
     + (SELECT COUNT(*) FROM conversations WHERE agent_id = $1)::int
     + (SELECT COUNT(*) FROM memories WHERE agent_id = $1)::int
     + (SELECT COUNT(*) FROM agent_grants WHERE agent_id = $1)::int AS n`,
    [id],
  );
  expect(left.rows[0]?.n).toBe(0);
  const again = await deleteAgent(
    new Request("http://localhost", { method: "DELETE" }),
    params(id),
  );
  expect(again.status).toBe(404);
});

it("renames the account and changes the password, signing out other sessions", async () => {
  const store = await openContext();
  const db = store.connection;
  const first = await signUpWithPassword(db, {
    email: "ada@example.com",
    password: "correct horse battery",
    name: "Ada",
  });
  const other = await signInWithPassword(db, {
    email: "ada@example.com",
    password: "correct horse battery",
  });

  expect(await renameAccount(db, first.user.id, "  Ada Lovelace ")).toBe("Ada Lovelace");
  await expect(renameAccount(db, first.user.id, "  ")).rejects.toThrow("Enter a name.");
  const account = await readAccount(db, first.user.id);
  expect(account).toMatchObject({ name: "Ada Lovelace", hasPassword: true, providers: [] });

  await expect(
    changePassword(db, {
      userId: first.user.id,
      current: "wrong password!!",
      next: "a brand new secret",
      keepSessionToken: first.sessionToken,
    }),
  ).rejects.toThrow("Current password is incorrect.");
  await expect(
    changePassword(db, {
      userId: first.user.id,
      current: "correct horse battery",
      next: "short",
      keepSessionToken: first.sessionToken,
    }),
  ).rejects.toThrow("Use at least 10 characters.");

  await changePassword(db, {
    userId: first.user.id,
    current: "correct horse battery",
    next: "a brand new secret",
    keepSessionToken: first.sessionToken,
  });
  expect(await readSessionUser(db, first.sessionToken)).not.toBeNull();
  expect(await readSessionUser(db, other.sessionToken)).toBeNull();
  await expect(
    signInWithPassword(db, { email: "ada@example.com", password: "correct horse battery" }),
  ).rejects.toThrow();
  await expect(
    signInWithPassword(db, { email: "ada@example.com", password: "a brand new secret" }),
  ).resolves.toBeTruthy();
});

it("won't change a password on an account that has none", async () => {
  const store = await openContext();
  await store.connection.query(
    `INSERT INTO users (id, name, email) VALUES ('g1', 'Grace', 'grace@example.com')`,
  );
  await expect(
    changePassword(store.connection, {
      userId: "g1",
      current: "anything at all",
      next: "a brand new secret",
      keepSessionToken: null,
    }),
  ).rejects.toThrow("signs in with Google");
});
