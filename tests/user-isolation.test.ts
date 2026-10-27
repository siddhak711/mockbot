import { afterEach, describe, expect, it } from "vitest";
import { POST as signInPassword } from "../app/api/auth/password/route";
import { POST as postChat } from "../app/api/chat/route";
import { GET as getComputer, POST as postComputer } from "../app/api/computer/route";
import {
  DELETE as deleteConnector,
  PATCH as patchConnector,
} from "../app/api/connectors/[id]/route";
import { PATCH as patchConnectorTools } from "../app/api/connectors/[id]/tools/route";
import { GET as listConnectors } from "../app/api/connectors/route";
import { GET as getConversation } from "../app/api/conversations/[id]/route";
import { GET as getRun } from "../app/api/runs/[id]/route";
import { POST as postApproval } from "../app/api/tools/approvals/route";
import { noteConnectorOutcome } from "../src/connectors/runtime";
import { getAppContext, resetAppContext, setAppContext } from "../src/context";
import { MockProvider, streamOptions, type LlmProvider, type StreamOptions } from "../src/llm";
import { openComputer } from "../src/sandbox/open";
import { SandboxTurnProvider } from "../src/sandbox/turn";
import { SseParser } from "../src/sse";
import { ConversationStore } from "../src/store";
import { ToolRegistry } from "../src/tools/registry";
import type { LlmMessage, LlmStreamEvent } from "../src/types";
import { startMockMcpServer } from "../scripts/mock-mcp-server.mjs";

// Under Vitest the auth guard skips sign-in and runs unscoped. These tests turn
// the guard on, so each request runs as one signed-in account.
const originalRequireAuth = process.env.MOCKBOT_REQUIRE_AUTH;

afterEach(async () => {
  if (originalRequireAuth === undefined) delete process.env.MOCKBOT_REQUIRE_AUTH;
  else process.env.MOCKBOT_REQUIRE_AUTH = originalRequireAuth;
  await resetAppContext();
});

type Account = { id: string; cookie: string; lead: string };

async function signUp(email: string): Promise<Account> {
  const response = await signInPassword(
    new Request("http://localhost:3000/api/auth/password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ intent: "sign-up", email, password: `${email} password` }),
    }),
  );
  expect(response.status).toBe(200);
  const match = response.headers.get("set-cookie")?.match(/authjs\.session-token=([^;]+)/);
  if (!match?.[1]) throw new Error("Missing session cookie");
  const { user } = (await response.json()) as { user: { id: string } };
  return { id: user.id, cookie: `authjs.session-token=${match[1]}`, lead: `lead_${user.id}` };
}

function as(account: Account, url: string, method = "GET", body?: unknown): Request {
  return new Request(url, {
    method,
    headers: { "Content-Type": "application/json", cookie: account.cookie },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

type SseEvent = { event: string; data: Record<string, unknown> };

async function readEvents(response: Response, until?: string) {
  if (!response.body) throw new Error("Expected a response body");
  const parser = new SseParser();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events: SseEvent[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const message of parser.push(decoder.decode(value, { stream: true }))) {
      const event = { event: message.event, data: JSON.parse(message.data) as SseEvent["data"] };
      events.push(event);
      if (event.event === until) return { events, reader };
    }
  }
  return { events, reader };
}

/** Records the tool names each model call was offered. */
class ToolListProvider implements LlmProvider {
  readonly id = "mock" as const;
  readonly model = null;
  offered: string[][] = [];

  async *stream(
    _messages: LlmMessage[],
    input?: StreamOptions | AbortSignal,
  ): AsyncIterable<LlmStreamEvent> {
    this.offered.push((streamOptions(input).tools ?? []).map((tool) => tool.name));
    yield { type: "start", role: "assistant" };
    yield { type: "text", text: "Listed." };
    yield { type: "end", finishReason: "stop" };
  }
}

describe("per-account isolation", { concurrent: false }, () => {
  it("keeps connectors, their tools, and their status to the owning account", async () => {
    process.env.MOCKBOT_REQUIRE_AUTH = "1";
    const adaServer = await startMockMcpServer();
    const beaServer = await startMockMcpServer();
    try {
      const store = await ConversationStore.open();
      const provider = new ToolListProvider();
      setAppContext({ store, provider, tools: new ToolRegistry() });
      const ada = await signUp("ada@example.com");
      const bea = await signUp("bea@example.com");
      const adaConnector = await store.createConnector({
        name: "Ada",
        transport: "http",
        target: adaServer.url,
        secretRef: null,
        userId: ada.id,
      });
      const beaConnector = await store.createConnector({
        name: "Bea",
        transport: "http",
        target: beaServer.url,
        secretRef: null,
        userId: bea.id,
      });

      const listed = await listConnectors(as(ada, "http://localhost/api/connectors"));
      const { connectors } = (await listed.json()) as { connectors: { id: string }[] };
      expect(connectors.map((connector) => connector.id)).toEqual([adaConnector.id]);

      const url = `http://localhost/api/connectors/${beaConnector.id}`;
      expect(
        (await patchConnector(as(ada, url, "PATCH", { enabled: false }), params(beaConnector.id)))
          .status,
      ).toBe(404);
      expect(
        (
          await patchConnectorTools(
            as(ada, `${url}/tools`, "PATCH", { tools: { echo: { enabled: false } } }),
            params(beaConnector.id),
          )
        ).status,
      ).toBe(404);
      expect((await deleteConnector(as(ada, url, "DELETE"), params(beaConnector.id))).status).toBe(
        404,
      );
      expect((await store.getConnector(beaConnector.id))?.enabled).toBe(true);

      const turn = await postChat(
        as(ada, "http://localhost/api/chat", "POST", { message: "What can you use?" }),
      );
      await readEvents(turn);
      const offered = provider.offered.flat();
      expect(offered).toContain("ada_echo");
      expect(offered).not.toContain("bea_echo");
      // The connector tools lived on that turn's copy only.
      const { tools } = await getAppContext();
      expect(tools.get("ada_echo")).toBeUndefined();

      // A failure reported for Ada's turn cannot pause Bea's connector.
      await noteConnectorOutcome(
        store,
        beaConnector.id,
        { isError: true, content: "401 unauthorized" },
        ada.id,
        ada.id,
      );
      expect((await store.getConnector(beaConnector.id))?.status).toBe("connected");
      await noteConnectorOutcome(
        store,
        adaConnector.id,
        { isError: true, content: "401 unauthorized" },
        ada.id,
        ada.id,
      );
      expect((await store.getConnector(adaConnector.id))?.status).toBe("reconnect");
    } finally {
      await adaServer.close();
      await beaServer.close();
    }
  });

  it("hides connectors from before accounts until the first account adopts them", async () => {
    process.env.MOCKBOT_REQUIRE_AUTH = "1";
    const store = await ConversationStore.open();
    setAppContext({ store, provider: new MockProvider({ delayMs: 0 }) });
    const legacy = await store.createConnector({
      name: "Legacy",
      transport: "http",
      target: "https://example.com/mcp",
      secretRef: null,
    });
    const first = await signUp("first@example.com");
    const second = await signUp("second@example.com");
    const read = async (account: Account) => {
      const response = await listConnectors(as(account, "http://localhost/api/connectors"));
      const body = (await response.json()) as { connectors: { id: string }[] };
      return body.connectors.map((connector) => connector.id);
    };
    expect(await read(second)).toEqual([]);
    expect(await read(first)).toEqual([legacy.id]);
    expect((await store.getConnector(legacy.id))?.userId).toBe(first.id);
    expect(await read(second)).toEqual([]);
  });

  it("gives each account's agent its own computer", async () => {
    process.env.MOCKBOT_REQUIRE_AUTH = "1";
    const supervisor = await openComputer({ env: { MOCK_SANDBOX: "1" }, dataDir: "memory://" });
    const store = await ConversationStore.open();
    setAppContext({
      store,
      sandbox: supervisor,
      provider: new SandboxTurnProvider({
        inner: new MockProvider({ delayMs: 0, chunkSize: 64 }),
        delayMs: 0,
      }),
    });
    const ada = await signUp("ada@example.com");
    const bea = await signUp("bea@example.com");
    const turn = await postChat(
      as(ada, "http://localhost/api/chat", "POST", {
        message:
          "Create a file named hello.txt that says hello from the sandbox, read it back, and run a command that prints it.",
      }),
    );
    await readEvents(turn);

    const files = async (account: Account, query = "") => {
      const response = await getComputer(as(account, `http://localhost/api/computer${query}`));
      if (response.status !== 200) return response.status;
      const snapshot = (await response.json()) as { files: { path: string }[] };
      return snapshot.files.map((file) => file.path);
    };
    expect(await files(ada)).toContain("hello.txt");
    expect(await files(bea)).not.toContain("hello.txt");
    expect(await files(bea, `?agentId=${ada.lead}`)).toBe(404);

    const read = await postComputer(
      as(bea, "http://localhost/api/computer", "POST", {
        tool: "read",
        agentId: ada.lead,
        path: "hello.txt",
      }),
    );
    expect(read.status).toBe(404);
    const own = await postComputer(
      as(bea, "http://localhost/api/computer", "POST", { tool: "read", path: "hello.txt" }),
    );
    const ownBody = (await own.json()) as { run: { stdout: string } };
    expect(ownBody.run.stdout).not.toContain("hello from the sandbox");
    await supervisor.close();
  });

  it("shows a run's events only to the conversation's owner", async () => {
    process.env.MOCKBOT_REQUIRE_AUTH = "1";
    const store = await ConversationStore.open();
    setAppContext({ store, provider: new MockProvider({ delayMs: 0 }) });
    const ada = await signUp("ada@example.com");
    const bea = await signUp("bea@example.com");
    const turn = await postChat(
      as(ada, "http://localhost/api/chat", "POST", { message: "Private plans" }),
    );
    const { events } = await readEvents(turn);
    const runId = String(events.find((event) => event.event === "done")?.data.runId ?? "");
    expect(runId).not.toBe("");

    const stranger = await getRun(as(bea, `http://localhost/api/runs/${runId}`), params(runId));
    expect(stranger.status).toBe(404);
    expect(JSON.stringify(await stranger.json())).not.toContain("Private plans");
    const owner = await getRun(as(ada, `http://localhost/api/runs/${runId}`), params(runId));
    expect(owner.status).toBe(200);
    expect(JSON.stringify(await owner.json())).toContain("Private plans");
    const missing = await getRun(as(ada, "http://localhost/api/runs/run_x"), params("run_x"));
    expect(missing.status).toBe(404);
  });

  it("keeps tool-call outputs and approvals apart when providers reuse a call id", async () => {
    process.env.MOCKBOT_REQUIRE_AUTH = "1";
    const tools = new ToolRegistry();
    tools.register({
      name: "whoami",
      description: "Names the speaking agent.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      approval: "never",
      async invoke(_args, context) {
        return { content: `speaker ${context.agentId}` };
      },
    });
    tools.register({
      name: "send_note",
      description: "Send a note. Requires approval.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      approval: "always",
      async invoke(_args, context) {
        return { content: `sent by ${context.agentId}` };
      },
    });
    const store = await ConversationStore.open();
    setAppContext({
      store,
      tools,
      provider: new MockProvider({
        delayMs: 0,
        tools: (messages) => {
          if (messages.some((message) => message.role === "tool")) return null;
          const text = [...messages].reverse().find((message) => message.role === "user");
          const name = text?.content.includes("send") ? "send_note" : "whoami";
          return [{ id: "call_same", name, arguments: "{}" }];
        },
      }),
    });
    const ada = await signUp("ada@example.com");
    const bea = await signUp("bea@example.com");

    const conversationOf = async (account: Account, message: string) => {
      const turn = await postChat(as(account, "http://localhost/api/chat", "POST", { message }));
      const { events } = await readEvents(turn);
      return String(events.find((event) => event.event === "done")?.data.conversationId ?? "");
    };
    const adaThread = await conversationOf(ada, "who are you");
    const beaThread = await conversationOf(bea, "who are you");
    const adaAgain = await conversationOf(ada, "who are you, again");
    expect(adaAgain).toBe(adaThread);

    const outputs = async (account: Account, id: string) => {
      const response = await getConversation(
        as(account, `http://localhost/api/conversations/${id}`),
        params(id),
      );
      if (response.status !== 200) return response.status;
      const body = (await response.json()) as {
        messages: { tools?: { id: string; output: string | null }[] }[];
      };
      return body.messages.flatMap((message) => message.tools ?? []).map((tool) => tool.output);
    };
    expect(await outputs(ada, adaThread)).toEqual([`speaker ${ada.lead}`, `speaker ${ada.lead}`]);
    expect(await outputs(bea, beaThread)).toEqual([`speaker ${bea.lead}`]);
    expect(await outputs(bea, adaThread)).toBe(404);

    // Both accounts wait on an approval with the same call id.
    const adaPending = await readEvents(
      await postChat(as(ada, "http://localhost/api/chat", "POST", { message: "send it" })),
      "approval_required",
    );
    const beaPending = await readEvents(
      await postChat(as(bea, "http://localhost/api/chat", "POST", { message: "send it" })),
      "approval_required",
    );
    const { approvals } = await getAppContext();
    expect(approvals.pendingConversations("call_same").sort()).toEqual(
      [adaThread, beaThread].sort(),
    );
    const decided = await postApproval(
      as(bea, "http://localhost/api/tools/approvals", "POST", {
        id: "call_same",
        decision: "approve",
      }),
    );
    expect(decided.status).toBe(200);
    await readEvents(new Response(readableFrom(beaPending.reader)));
    expect(approvals.pendingConversations("call_same")).toEqual([adaThread]);
    const stop = await postApproval(
      as(ada, "http://localhost/api/tools/approvals", "POST", {
        id: "call_same",
        decision: "deny",
        conversationId: adaThread,
      }),
    );
    expect(stop.status).toBe(200);
    await readEvents(new Response(readableFrom(adaPending.reader)));
    expect(await outputs(bea, beaThread)).toContain(`sent by ${bea.lead}`);
    expect(await outputs(ada, adaThread)).not.toContain(`sent by ${bea.lead}`);
  });
});

function readableFrom(reader: ReadableStreamDefaultReader<Uint8Array>): ReadableStream<Uint8Array> {
  return new ReadableStream({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
  });
}
