import { afterEach, expect, it } from "vitest";
import { GET, POST } from "../app/api/agents/route";
import { POST as sendChat } from "../app/api/chat/route";
import { LEAD_AGENT_ID, LEAD_AGENT_NAME } from "../src/agents/ids";
import { resetAppContext, setAppContext } from "../src/context";
import { SYSTEM_PROMPT, MockProvider } from "../src/llm";
import { BASE_SYSTEM_PROMPT } from "../src/memory/prompt";
import { ConversationStore } from "../src/store";
import { deltas, readSse } from "./helpers";

afterEach(async () => {
  await resetAppContext();
});

it("seeds the milestone 1 prompt and creates a second agent", async () => {
  const store = await ConversationStore.open();
  setAppContext({ store, provider: new MockProvider({ delayMs: 0 }) });

  const listed = await GET();
  expect(listed.status).toBe(200);
  const body = (await listed.json()) as {
    agents: Array<{ id: string; name: string; instructions: string; grants: unknown[] }>;
  };
  expect(body.agents.map((agent) => agent.name)).toEqual([LEAD_AGENT_NAME]);
  expect(body.agents[0]?.id).toBe(LEAD_AGENT_ID);
  expect(body.agents[0]?.instructions).toBe(SYSTEM_PROMPT);
  expect(body.agents[0]?.grants).toEqual([]);

  const created = await POST(
    new Request("http://localhost/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Researcher",
        instructions: "You study groves and answer in one sentence.",
        memoryNote: "The grove code is 42",
        computerId: "desk",
        connectorId: "calendar",
      }),
    }),
  );
  expect(created.status).toBe(201);
  const agent = (await created.json()) as {
    agent: { id: string; name: string; instructions: string; memoryNote: string };
    grants: Array<{ kind: string; resourceId: string }>;
  };
  expect(agent.agent.name).toBe("Researcher");
  expect(agent.agent.instructions).not.toBe(SYSTEM_PROMPT);
  expect(agent.agent.memoryNote).toBe("The grove code is 42");
  expect(agent.grants.map((grant) => [grant.kind, grant.resourceId]).sort()).toEqual([
    ["computer", "desk"],
    ["connector", "calendar"],
  ]);

  const again = await POST(
    new Request("http://localhost/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "researcher",
        instructions: "Different",
      }),
    }),
  );
  expect(again.status).toBe(409);

  const leadChat = await store.createConversation("Lead thread");
  const childChat = await store.createConversation("Child thread", agent.agent.id);
  expect(leadChat.agentId).toBe(LEAD_AGENT_ID);
  expect(childChat.agentId).toBe(agent.agent.id);
  expect((await store.getConversation(childChat.id))?.conversation.agentId).toBe(agent.agent.id);
});

it("leaves no agent behind when a grant id is invalid", async () => {
  const store = await ConversationStore.open();
  setAppContext({ store, provider: new MockProvider({ delayMs: 0 }) });

  const rejected = await POST(
    new Request("http://localhost/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Researcher",
        instructions: "You study groves.",
        computerId: "desk",
        connectorId: "not a connector",
      }),
    }),
  );
  expect(rejected.status).toBe(400);
  const afterFailure = (await (await GET()).json()) as { agents: Array<{ name: string }> };
  expect(afterFailure.agents.map((agent) => agent.name)).toEqual([LEAD_AGENT_NAME]);

  const retry = await POST(
    new Request("http://localhost/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Researcher",
        instructions: "You study groves.",
        computerId: "desk",
      }),
    }),
  );
  expect(retry.status).toBe(201);
  const body = (await retry.json()) as {
    agent: { name: string };
    grants: Array<{ kind: string; resourceId: string }>;
  };
  expect(body.agent.name).toBe("Researcher");
  expect(body.grants.map((grant) => [grant.kind, grant.resourceId])).toEqual([
    ["computer", "desk"],
  ]);
});

it("includes the milestone 1 prompt and the memory rules on an ordinary lead turn", async () => {
  let system = "";
  const store = await ConversationStore.open();
  setAppContext({
    store,
    provider: new MockProvider({
      delayMs: 0,
      reply: (messages) => {
        system = messages.find((message) => message.role === "system")?.content ?? "";
        return "ok";
      },
    }),
  });

  const response = await sendChat(
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Say hello" }),
    }),
  );
  expect(response.status).toBe(200);
  const events = await readSse(response);
  expect(deltas(events)).toBe("ok");
  expect(system).toBe(BASE_SYSTEM_PROMPT);
  expect(system.startsWith(SYSTEM_PROMPT)).toBe(true);
});
