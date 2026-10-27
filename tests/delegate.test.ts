import { afterEach, expect, it } from "vitest";
import { POST as createAgent } from "../app/api/agents/route";
import { POST } from "../app/api/chat/route";
import { AgentDirectory } from "../src/agents/directory";
import { performDelegation } from "../src/agents/delegate";
import { LEAD_AGENT_ID } from "../src/agents/ids";
import { withAgentMock } from "../src/agents/mock-script";
import { defaultComputer, defaultConnector, NoteMemory } from "../src/agents/ports";
import { RunLog, listRunEvents } from "../src/runs/events";
import type { AgentMemoryPort, ComputerPort, ConnectorPort } from "../src/agents/types";
import type { LlmMessage } from "../src/types";
import { resetAppContext, setAppContext } from "../src/context";
import { buildMockReply, MockProvider } from "../src/llm";
import { ConversationStore } from "../src/store";
import { deltas, listConversations, readSse } from "./helpers";

afterEach(async () => {
  await resetAppContext();
});

function systemOf(messages: { role: string; content: string }[]): string {
  return messages.find((message) => message.role === "system")?.content ?? "";
}

it("delegates a subtask and gives the child its own memory and computer", async () => {
  const prompts: string[] = [];
  const reads: string[] = [];
  const connectorCalls: string[] = [];
  let researcherId = "";
  const memory: AgentMemoryPort = {
    async list(agentId: string) {
      if (agentId === researcherId) return [{ key: "grove", content: "child-only-fact" }];
      if (agentId === LEAD_AGENT_ID) return [{ key: "secret", content: "parent-only-fact" }];
      return [];
    },
  };
  const computer: ComputerPort = {
    async read(computerId: string, path: string) {
      reads.push(`${computerId}:${path}`);
      return "desk-file";
    },
  };
  const connector: ConnectorPort = {
    async call(connectorId: string) {
      connectorCalls.push(connectorId);
      return "sent";
    },
  };
  const store = await ConversationStore.open();
  setAppContext({
    store,
    memory,
    computer,
    connector,
    provider: new MockProvider({
      delayMs: 0,
      chunkSize: 80,
      tools: (messages) => {
        if (systemOf(messages).includes("delegation: child")) {
          return [
            {
              id: "call_computer",
              name: "use_computer",
              arguments: JSON.stringify({ computerId: "desk", path: "notes.txt" }),
            },
          ];
        }
        return [
          {
            id: "call_delegate",
            name: "delegate",
            arguments: JSON.stringify({ agent: "Researcher", task: "Read the notes" }),
          },
        ];
      },
      reply: (messages) => {
        const system = systemOf(messages);
        prompts.push(system);
        if (system.includes("delegation: child")) return "Notes received";
        return undefined;
      },
    }),
  });

  const created = await createAgent(
    new Request("http://localhost/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Researcher",
        instructions: "You read notes and nothing else.",
        computerId: "desk",
      }),
    }),
  );
  expect(created.status).toBe(201);
  researcherId = ((await created.json()) as { agent: { id: string } }).agent.id;

  const response = await POST(
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Ask the researcher to read the notes" }),
    }),
  );
  expect(response.status).toBe(200);
  const events = await readSse(response);
  expect(events.some((event) => event.event === "error")).toBe(false);
  expect(deltas(events)).toBe("Delegated to Researcher.");
  const result = events.find((event) => event.event === "tool_result")?.data as {
    name?: string;
    content?: string;
  };
  expect(result.name).toBe("delegate");
  expect(result.content).toContain("Notes received");
  expect(result.content).toContain("desk-file");
  expect(result.content).not.toContain("parent-only-fact");
  expect(result.content?.startsWith("Delegation failed")).toBe(false);

  const childPrompt = prompts.find((prompt) => prompt.includes("delegation: child")) ?? "";
  expect(childPrompt).toContain("child-only-fact");
  expect(childPrompt).toContain("You read notes and nothing else.");
  expect(childPrompt).not.toContain("parent-only-fact");
  const parentPrompt = prompts.find((prompt) => !prompt.includes("delegation: child")) ?? "";
  expect(parentPrompt).toContain("parent-only-fact");
  expect(parentPrompt).not.toContain("child-only-fact");
  expect(reads).toEqual(["desk:notes.txt"]);
  expect(connectorCalls).toEqual([]);

  const listed = await listConversations(store);
  const child = listed.find((conversation) => conversation.agentId === researcherId);
  const parent = listed.find((conversation) => conversation.agentId === LEAD_AGENT_ID);
  expect(child?.title).toBe("Read the notes");
  expect(parent).toBeTruthy();
  const loaded = await store.getConversation(child!.id);
  expect(loaded?.messages.map((message) => [message.role, message.content])).toEqual([
    ["user", "Read the notes"],
    ["assistant", "Notes received"],
  ]);
  expect(loaded?.messages[1]?.trace?.tools[0]).toMatchObject({
    name: "use_computer",
    result: "desk-file",
  });
  const parentMessages = await store.getConversation(parent!.id);
  expect(parentMessages?.messages[1]?.trace?.tools[0]?.result).toContain("desk-file");
});

it("shows a grant refusal on the parent turn and leaves that conversation usable", async () => {
  const reads: string[] = [];
  const connectorCalls: string[] = [];
  let parentTurns = 0;
  const store = await ConversationStore.open();
  setAppContext({
    store,
    computer: {
      async read(computerId: string, path: string) {
        reads.push(`${computerId}:${path}`);
        return "should-not-read";
      },
    },
    connector: {
      async call(connectorId: string) {
        connectorCalls.push(connectorId);
        return "should-not-send";
      },
    },
    provider: new MockProvider({
      delayMs: 0,
      chunkSize: 80,
      tools: (messages) => {
        if (systemOf(messages).includes("delegation: child")) {
          return [
            {
              id: "call_mail",
              name: "use_connector",
              arguments: JSON.stringify({ connectorId: "mail", tool: "send" }),
            },
            {
              id: "call_box",
              name: "use_computer",
              arguments: JSON.stringify({ computerId: "other-desk", path: "secret.txt" }),
            },
          ];
        }
        parentTurns += 1;
        if (parentTurns === 1) {
          return [
            {
              id: "call_delegate",
              name: "delegate",
              arguments: JSON.stringify({ agent: "Researcher", task: "Send the mail" }),
            },
          ];
        }
        return null;
      },
      reply: (messages) => {
        if (systemOf(messages).includes("delegation: child")) return "Child tried";
        if (parentTurns > 1) return "Still working";
        return undefined;
      },
    }),
  });

  const created = await createAgent(
    new Request("http://localhost/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Researcher",
        instructions: "You cannot use ungranted tools.",
      }),
    }),
  );
  const researcherId = ((await created.json()) as { agent: { id: string } }).agent.id;

  const response = await POST(
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Delegate the mail" }),
    }),
  );
  const events = await readSse(response);
  expect(events.some((event) => event.event === "error")).toBe(false);
  expect(deltas(events)).toBe("The handoff failed. This conversation can continue.");
  const result = String(
    (events.find((event) => event.event === "tool_result")?.data as { content?: string }).content,
  );
  expect(result.startsWith("Delegation failed")).toBe(true);
  expect(result).toContain("not granted connector mail");
  expect(result).toContain("not granted computer other-desk");
  expect(result).not.toContain("should-not");
  expect(reads).toEqual([]);
  expect(connectorCalls).toEqual([]);

  const parent = (await listConversations(store)).find(
    (conversation) => conversation.agentId === LEAD_AGENT_ID,
  );
  const followUp = await POST(
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Still here", conversationId: parent!.id }),
    }),
  );
  const followEvents = await readSse(followUp);
  expect(followEvents.some((event) => event.event === "error")).toBe(false);
  expect(deltas(followEvents)).toBe("Still working");
  const loaded = await store.getConversation(parent!.id);
  expect(loaded?.messages.map((message) => message.content)).toEqual([
    "Delegate the mail",
    "The handoff failed. This conversation can continue.",
    "Still here",
    "Still working",
  ]);
  const child = (await listConversations(store)).find(
    (conversation) => conversation.agentId === researcherId,
  );
  expect(child).toBeTruthy();
  const childMessages = await store.getConversation(child!.id);
  expect(childMessages?.conversation.agentId).toBe(researcherId);
  expect(childMessages?.messages[0]?.content).toBe("Send the mail");
});

it("refuses a nested delegate from the child", async () => {
  const store = await ConversationStore.open();
  setAppContext({
    store,
    provider: new MockProvider({
      delayMs: 0,
      tools: (messages) => {
        if (systemOf(messages).includes("delegation: child")) {
          return [
            {
              id: "call_nested",
              name: "delegate",
              arguments: JSON.stringify({ agent: "Ghost", task: "again" }),
            },
          ];
        }
        return [
          {
            id: "call_delegate",
            name: "delegate",
            arguments: JSON.stringify({ agent: "Researcher", task: "Nest" }),
          },
        ];
      },
      reply: () => undefined,
    }),
  });
  await createAgent(
    new Request("http://localhost/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Researcher", instructions: "Stay here." }),
    }),
  );
  const response = await POST(
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Nest this" }),
    }),
  );
  const events = await readSse(response);
  const result = String(
    (events.find((event) => event.event === "tool_result")?.data as { content?: string }).content,
  );
  expect(result).toContain("cannot delegate further");
  expect(deltas(events)).toBe("The handoff failed. This conversation can continue.");
  const names = new Set((await listConversations(store)).map((conversation) => conversation.title));
  expect(names.has("again")).toBe(false);
  expect(
    (await listConversations(store)).filter(
      (conversation) => conversation.agentId !== LEAD_AGENT_ID,
    ),
  ).toHaveLength(1);
});

it("runs the live mock handoff for a delegate phrase", async () => {
  const store = await ConversationStore.open();
  setAppContext({
    store,
    provider: withAgentMock(new MockProvider({ delayMs: 0, chunkSize: 24 })),
    computer: {
      async read(computerId, path) {
        return `Granted computer ${computerId} (${path}).`;
      },
    },
  });
  const created = await createAgent(
    new Request("http://localhost/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Researcher",
        instructions: "You study groves.",
        memoryNote: "The grove code is 42",
        computerId: "desk",
      }),
    }),
  );
  const researcherId = ((await created.json()) as { agent: { id: string } }).agent.id;

  const response = await POST(
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "delegate to Researcher: What is the grove code?",
      }),
    }),
  );
  const events = await readSse(response);
  expect(events.some((event) => event.event === "error")).toBe(false);
  expect(deltas(events)).toBe("Delegated to Researcher.");
  const call = events.find(
    (event) => event.event === "tool_call" && (event.data as { name?: string }).name === "delegate",
  );
  expect(call).toBeTruthy();
  const result = String(
    (events.find((event) => event.event === "tool_result")?.data as { content?: string }).content,
  );
  expect(result).toContain("The grove code is 42");
  expect(result).toContain("Granted computer desk");
  expect(result).toContain("You study groves.");
  const child = (await listConversations(store)).find(
    (conversation) => conversation.agentId === researcherId,
  );
  expect(child?.title).toBe("What is the grove code?");
  const loaded = await store.getConversation(child!.id);
  expect(loaded?.messages[0]?.content).toBe("What is the grove code?");
  expect(loaded?.messages[1]?.content).toContain("The grove code is 42");

  const ordinary = await POST(
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Say hello" }),
    }),
  );
  const ordinaryEvents = await readSse(ordinary);
  expect(deltas(ordinaryEvents)).toBe(buildMockReply("Say hello"));
});

it("keeps the child result in the next lead turn", async () => {
  let parentTurns = 0;
  const followUps: string[] = [];
  const store = await ConversationStore.open();
  setAppContext({
    store,
    computer: {
      async read() {
        return "desk-file";
      },
    },
    provider: new MockProvider({
      delayMs: 0,
      chunkSize: 80,
      tools: (messages) => {
        if (systemOf(messages).includes("delegation: child")) {
          return [
            {
              id: "call_computer",
              name: "use_computer",
              arguments: JSON.stringify({ computerId: "desk", path: "notes.txt" }),
            },
          ];
        }
        parentTurns += 1;
        if (parentTurns === 1) {
          return [
            {
              id: "call_delegate",
              name: "delegate",
              arguments: JSON.stringify({ agent: "Researcher", task: "Read the notes" }),
            },
          ];
        }
        return null;
      },
      reply: (messages) => {
        if (systemOf(messages).includes("delegation: child")) return "Notes received";
        if (parentTurns > 1) {
          followUps.push(messages.map((message) => message.content).join("\n"));
          return "Still working";
        }
        return undefined;
      },
    }),
  });
  await createAgent(
    new Request("http://localhost/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Researcher",
        instructions: "You read notes.",
        computerId: "desk",
      }),
    }),
  );

  const response = await POST(
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Ask the researcher" }),
    }),
  );
  const events = await readSse(response);
  expect(events.some((event) => event.event === "error")).toBe(false);
  const parent = (await listConversations(store)).find(
    (conversation) => conversation.agentId === LEAD_AGENT_ID,
  );
  const saved = await store.getConversation(parent!.id);
  const delegate = saved?.messages
    .flatMap((message) => message.tools ?? [])
    .find((tool) => tool.name === "delegate");
  expect(delegate?.status).toBe("done");
  expect(delegate?.output).toContain("desk-file");
  expect(delegate?.output).toContain("Notes received");

  const followUp = await POST(
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "What did they find?", conversationId: parent!.id }),
    }),
  );
  expect(deltas(await readSse(followUp))).toBe("Still working");
  expect(followUps).toHaveLength(1);
  expect(followUps[0]).toContain("desk-file");
  expect(followUps[0]).toContain("Notes received");
});

it("refuses a delegation from Mockbot to itself and keeps the conversation", async () => {
  let parentTurns = 0;
  const store = await ConversationStore.open();
  setAppContext({
    store,
    provider: new MockProvider({
      delayMs: 0,
      chunkSize: 80,
      tools: () => {
        parentTurns += 1;
        if (parentTurns === 1) {
          return [
            {
              id: "call_self",
              name: "delegate",
              arguments: JSON.stringify({ agent: "Mockbot", task: "hello" }),
            },
          ];
        }
        return null;
      },
      reply: () => (parentTurns > 1 ? "Still working" : undefined),
    }),
  });

  const response = await POST(
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "delegate to Mockbot: hello" }),
    }),
  );
  const events = await readSse(response);
  expect(events.some((event) => event.event === "error")).toBe(false);
  const result = String(
    (events.find((event) => event.event === "tool_result")?.data as { content?: string }).content,
  );
  expect(result.startsWith("Delegation failed")).toBe(true);
  expect(result).toContain("cannot delegate to itself");
  expect(deltas(events)).toBe("The handoff failed. This conversation can continue.");
  const listed = await listConversations(store);
  expect(listed).toHaveLength(1);
  expect(listed[0]?.agentId).toBe(LEAD_AGENT_ID);
  expect(listed.some((conversation) => conversation.title === "hello")).toBe(false);

  const followUp = await POST(
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Still here", conversationId: listed[0]?.id }),
    }),
  );
  const followEvents = await readSse(followUp);
  expect(followEvents.some((event) => event.event === "error")).toBe(false);
  expect(deltas(followEvents)).toBe("Still working");
});

it("does not register delegate on another agent's conversation", async () => {
  let turns = 0;
  const store = await ConversationStore.open();
  setAppContext({
    store,
    provider: new MockProvider({
      delayMs: 0,
      chunkSize: 80,
      tools: () => {
        turns += 1;
        if (turns > 1) return null;
        return [
          {
            id: "call_delegate",
            name: "delegate",
            arguments: JSON.stringify({ agent: "Clerk", task: "file this" }),
          },
        ];
      },
      reply: () => (turns > 1 ? "Researcher stayed here" : undefined),
    }),
  });
  const created = await createAgent(
    new Request("http://localhost/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Researcher", instructions: "Stay in this chat." }),
    }),
  );
  const researcherId = ((await created.json()) as { agent: { id: string } }).agent.id;

  const response = await POST(
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Please file this", agentId: researcherId }),
    }),
  );
  const events = await readSse(response);
  expect(events.some((event) => event.event === "error")).toBe(false);
  expect(deltas(events)).toContain("Researcher stayed here");
  const toolOutput = events
    .filter((event) => event.event === "tool_result")
    .map((event) => JSON.stringify(event.data))
    .join("\n");
  expect(toolOutput).toContain("Unknown tool");
  expect(toolOutput).not.toContain("file this");
  const listed = await listConversations(store);
  expect(listed).toHaveLength(1);
  expect(listed[0]?.agentId).toBe(researcherId);
  expect(listed.some((conversation) => conversation.title === "file this")).toBe(false);
});

it("refuses an ungranted connector from the live delegate phrase", async () => {
  const connectorCalls: string[] = [];
  const store = await ConversationStore.open();
  setAppContext({
    store,
    connector: {
      async call(connectorId: string) {
        connectorCalls.push(connectorId);
        return "sent";
      },
    },
    provider: withAgentMock(new MockProvider({ delayMs: 0, chunkSize: 24 })),
  });
  await createAgent(
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

  const response = await POST(
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "delegate to Researcher: use connector mail" }),
    }),
  );
  const events = await readSse(response);
  expect(events.some((event) => event.event === "error")).toBe(false);
  expect(deltas(events)).toBe("The handoff failed. This conversation can continue.");
  const result = String(
    (events.find((event) => event.event === "tool_result")?.data as { content?: string }).content,
  );
  expect(result.startsWith("Delegation failed")).toBe(true);
  expect(result).toContain("not granted connector mail");
  expect(connectorCalls).toEqual([]);

  const parent = (await listConversations(store)).find(
    (conversation) => conversation.agentId === LEAD_AGENT_ID,
  );
  const followUp = await POST(
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Say hello", conversationId: parent?.id }),
    }),
  );
  expect(deltas(await readSse(followUp))).toBe(buildMockReply("Say hello"));
});

it("sends a delegated turn through the summary instead of the covered history", async () => {
  const seen: LlmMessage[][] = [];
  const store = await ConversationStore.open();
  const directory = await AgentDirectory.attach(store);
  const researcher = await directory.create({
    name: "Researcher",
    instructions: "You read notes and nothing else.",
  });
  const conversation = await store.getOrCreateAgentConversation(researcher.id, null);
  await store.addMessage(conversation.id, "user", "secret older note");
  const covered = await store.addMessage(conversation.id, "assistant", "noted the secret");
  await store.saveSummary(
    conversation.id,
    researcher.id,
    "The grove was already summarized.",
    covered.id,
  );
  const provider = new MockProvider({
    delayMs: 0,
    chunkSize: 40,
    onMessages: (messages) => {
      seen.push(messages);
    },
    reply: () => "Next step is the ridge.",
  });

  const outcome = await performDelegation(
    { agent: "Researcher", task: "What next?" },
    {
      directory,
      store,
      provider,
      memory: new NoteMemory(directory),
      computer: defaultComputer,
      connector: defaultConnector,
      parentAgentId: LEAD_AGENT_ID,
    },
  );

  expect(outcome.isError).toBe(false);
  expect(outcome.content).toContain("Next step is the ridge.");
  const child = seen[0] ?? [];
  const system = child.find((message) => message.role === "system")?.content ?? "";
  expect(system).toContain("delegation: child");
  expect(system).toContain("<conversation-summary");
  expect(system).toContain("The grove was already summarized.");
  expect(
    child.filter((message) => message.role === "user").map((message) => message.content),
  ).toEqual(["What next?"]);
  expect(child.map((message) => message.content).join("\n")).not.toContain("secret older note");
  expect(child.map((message) => message.content).join("\n")).not.toContain("noted the secret");

  const stored = await store.getConversation(conversation.id);
  expect(stored?.messages.map((message) => message.content)).toEqual([
    "secret older note",
    "noted the secret",
    "What next?",
    "Next step is the ridge.",
  ]);
});

it("records a stopped handoff as stopped", async () => {
  const store = await ConversationStore.open();
  const directory = await AgentDirectory.attach(store);
  const log = new RunLog(store.connection, "run_stopped_delegate");
  await expect(
    performDelegation(
      { agent: "Researcher", task: "Stop this" },
      {
        directory,
        store,
        provider: new MockProvider({ delayMs: 0 }),
        memory: new NoteMemory(directory),
        computer: defaultComputer,
        connector: defaultConnector,
        parentAgentId: LEAD_AGENT_ID,
        signal: AbortSignal.abort(),
        runLog: log,
      },
    ),
  ).rejects.toThrow(/aborted/);

  const rows = await listRunEvents(store.connection, "run_stopped_delegate");
  const delegate = rows.find((row) => row.type === "tool");
  expect(delegate?.output).toBe("Delegation stopped.");
  expect(delegate?.output).not.toContain("failed");
  expect(rows.some((row) => row.type === "error")).toBe(false);
});
