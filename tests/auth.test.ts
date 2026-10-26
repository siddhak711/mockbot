import { NextRequest } from "next/server";
import { afterEach, expect, it } from "vitest";
import { GET as listAgents, POST as createAgent } from "../app/api/agents/route";
import { handlers } from "../src/auth";
import { POST as signInPassword } from "../app/api/auth/password/route";
import { GET as readConversation } from "../app/api/conversations/[id]/route";
import { GET as listConversationIndex } from "../app/api/conversations/route";
import { googleCallbackUrl } from "../src/auth/google";
import { resetAppContext, setAppContext } from "../src/context";
import { MockProvider } from "../src/llm";
import { prepareUser } from "../src/auth/scope";
import { AgentDirectory } from "../src/agents/directory";
import { ConversationStore } from "../src/store";

const originalRequireAuth = process.env.MOCKBOT_REQUIRE_AUTH;
const originalGoogleId = process.env.GOOGLE_CLIENT_ID;
const originalGoogleSecret = process.env.GOOGLE_CLIENT_SECRET;

afterEach(async () => {
  if (originalRequireAuth === undefined) delete process.env.MOCKBOT_REQUIRE_AUTH;
  else process.env.MOCKBOT_REQUIRE_AUTH = originalRequireAuth;
  if (originalGoogleId === undefined) delete process.env.GOOGLE_CLIENT_ID;
  else process.env.GOOGLE_CLIENT_ID = originalGoogleId;
  if (originalGoogleSecret === undefined) delete process.env.GOOGLE_CLIENT_SECRET;
  else process.env.GOOGLE_CLIENT_SECRET = originalGoogleSecret;
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

async function openStore(): Promise<ConversationStore> {
  const store = await ConversationStore.open();
  setAppContext({ store, provider: new MockProvider({ delayMs: 0 }) });
  return store;
}

it("signs up, stores a bcrypt hash, and restores the session from the cookie", async () => {
  const store = await openStore();
  const created = await signInPassword(
    passwordRequest({
      intent: "sign-up",
      name: "Ada",
      email: "Ada@Example.com",
      password: "correct horse battery",
    }),
  );
  expect(created.status).toBe(200);
  const setCookie = created.headers.get("set-cookie");
  expect(setCookie).toContain("authjs.session-token=");
  expect(setCookie?.toLowerCase()).toContain("httponly");
  expect(setCookie?.toLowerCase()).not.toContain("secure");
  const body = (await created.json()) as { user: { id: string; email: string; name: string } };
  expect(body.user.email).toBe("ada@example.com");
  expect(body.user.name).toBe("Ada");
  expect(JSON.stringify(body)).not.toContain("correct horse battery");

  const stored = await store.connection.query<{ password_hash: string | null }>(
    "SELECT password_hash FROM users WHERE id = $1",
    [body.user.id],
  );
  const hash = stored.rows[0]?.password_hash ?? "";
  expect(hash.startsWith("$2")).toBe(true);
  expect(hash).not.toContain("correct horse battery");

  const session = await handlers.GET(
    new NextRequest("http://localhost:3000/api/auth/session", {
      headers: { cookie: cookiePair(setCookie) },
    }),
  );
  expect(session.status).toBe(200);
  const sessionBody = (await session.json()) as { user?: { id?: string; email?: string } };
  expect(sessionBody.user?.id).toBe(body.user.id);
  expect(sessionBody.user?.email).toBe("ada@example.com");

  const again = await signInPassword(
    passwordRequest({
      intent: "sign-in",
      email: "ada@example.com",
      password: "correct horse battery",
    }),
  );
  expect(again.status).toBe(200);

  const wrong = await signInPassword(
    passwordRequest({
      intent: "sign-in",
      email: "ada@example.com",
      password: "not-the-password",
    }),
  );
  expect(wrong.status).toBe(401);

  const missing = await signInPassword(
    passwordRequest({
      intent: "sign-in",
      email: "nobody@example.com",
      password: "correct horse battery",
    }),
  );
  expect(missing.status).toBe(401);
  expect(((await wrong.json()) as { error: string }).error).toBe(
    ((await missing.json()) as { error: string }).error,
  );

  const duplicate = await signInPassword(
    passwordRequest({
      intent: "sign-up",
      email: "ada@example.com",
      password: "another strong password",
    }),
  );
  expect(duplicate.status).toBe(409);

  const short = await signInPassword(
    passwordRequest({ intent: "sign-up", email: "short@example.com", password: "short" }),
  );
  expect(short.status).toBe(400);
});

it("gives each account its own agents and conversations, and adopts orphan rows once", async () => {
  const store = await openStore();
  await AgentDirectory.attach(store);
  const orphan = await store.createConversation("Before accounts");
  await store.memories.write({
    agentId: "agent_default",
    key: "city",
    content: "Lisbon",
    createdBy: "user",
  });

  process.env.MOCKBOT_REQUIRE_AUTH = "1";
  const first = await signInPassword(
    passwordRequest({
      intent: "sign-up",
      email: "first@example.com",
      password: "first account password",
    }),
  );
  const second = await signInPassword(
    passwordRequest({
      intent: "sign-up",
      email: "second@example.com",
      password: "second account password",
    }),
  );
  expect(first.status).toBe(200);
  expect(second.status).toBe(200);
  const firstCookie = cookiePair(first.headers.get("set-cookie"));
  const secondCookie = cookiePair(second.headers.get("set-cookie"));

  const firstAgents = await listAgents(
    new Request("http://localhost/api/agents", { headers: { cookie: firstCookie } }),
  );
  const secondAgents = await listAgents(
    new Request("http://localhost/api/agents", { headers: { cookie: secondCookie } }),
  );
  const firstBody = (await firstAgents.json()) as {
    agents: Array<{ id: string; name: string; isLead: boolean }>;
  };
  const secondBody = (await secondAgents.json()) as {
    agents: Array<{ id: string; name: string; isLead: boolean }>;
  };
  expect(firstBody.agents.some((agent) => agent.id === "agent_default" && agent.isLead)).toBe(true);
  expect(secondBody.agents.some((agent) => agent.id === "agent_default")).toBe(false);
  expect(secondBody.agents.some((agent) => agent.isLead && agent.name === "Mockbot")).toBe(true);

  const firstChats = await listConversationIndex(
    new Request("http://localhost/api/conversations", { headers: { cookie: firstCookie } }),
  );
  const secondChats = await listConversationIndex(
    new Request("http://localhost/api/conversations", { headers: { cookie: secondCookie } }),
  );
  const firstList = (await firstChats.json()) as { conversations: Array<{ id: string }> };
  const secondList = (await secondChats.json()) as { conversations: Array<{ id: string }> };
  expect(firstList.conversations.map((item) => item.id)).toContain(orphan.id);
  expect(secondList.conversations.map((item) => item.id)).not.toContain(orphan.id);

  const hidden = await readConversation(
    new Request(`http://localhost/api/conversations/${orphan.id}`, {
      headers: { cookie: secondCookie },
    }),
    { params: Promise.resolve({ id: orphan.id }) },
  );
  expect(hidden.status).toBe(404);

  const created = await createAgent(
    new Request("http://localhost/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: secondCookie },
      body: JSON.stringify({ name: "Researcher", instructions: "Look things up." }),
    }),
  );
  expect(created.status).toBe(201);
  const after = await listAgents(
    new Request("http://localhost/api/agents", { headers: { cookie: firstCookie } }),
  );
  const afterBody = (await after.json()) as { agents: Array<{ name: string }> };
  expect(afterBody.agents.map((agent) => agent.name)).not.toContain("Researcher");

  const owners = await store.connection.query<{ user_id: string | null }>(
    "SELECT user_id FROM memories WHERE key = 'city'",
  );
  const firstUser = (await first.json()) as { user: { id: string } };
  expect(owners.rows[0]?.user_id).toBe(firstUser.user.id);
});

it("refuses workspace APIs when a session is required and the cookie is missing", async () => {
  await openStore();
  process.env.MOCKBOT_REQUIRE_AUTH = "1";
  const response = await listConversationIndex();
  expect(response.status).toBe(401);
});

it("registers the Google callback when client credentials are set", async () => {
  await openStore();
  expect(googleCallbackUrl("https://mockbot-jet.vercel.app")).toBe(
    "https://mockbot-jet.vercel.app/api/auth/callback/google",
  );
  process.env.GOOGLE_CLIENT_ID = "demo-client-id";
  process.env.GOOGLE_CLIENT_SECRET = "demo-client-secret";
  const response = await handlers.GET(new NextRequest("http://localhost:3000/api/auth/providers"));
  expect(response.status).toBe(200);
  const providers = (await response.json()) as {
    google?: { callbackUrl?: string; id?: string };
  };
  expect(providers.google?.id).toBe("google");
  expect(providers.google?.callbackUrl).toBe("http://localhost:3000/api/auth/callback/google");
});

it("does not adopt orphan rows for a later account", async () => {
  const store = await openStore();
  await AgentDirectory.attach(store);
  await store.createConversation("Legacy");
  const { signUpWithPassword } = await import("../src/auth/password");
  const first = await signUpWithPassword(store.connection, {
    email: "owner@example.com",
    password: "owner password value",
  });
  const second = await signUpWithPassword(store.connection, {
    email: "guest@example.com",
    password: "guest password value",
  });
  await prepareUser(store.connection, second.user.id);
  expect(await store.listConversations(second.user.id)).toEqual([]);
  await prepareUser(store.connection, first.user.id);
  expect((await store.listConversations(first.user.id)).map((item) => item.title)).toEqual([
    "Legacy",
  ]);
});
