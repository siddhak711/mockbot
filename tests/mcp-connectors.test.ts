import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { POST as postChat } from "../app/api/chat/route";
import {
  DELETE as deleteConnector,
  PATCH as patchConnector,
} from "../app/api/connectors/[id]/route";
import { GET as getConnectors, POST as createConnector } from "../app/api/connectors/route";
import { GET as readConversation } from "../app/api/conversations/[id]/route";
import { parseConnectorInput } from "../src/connectors";
import { resetAppContext, setAppContext } from "../src/context";
import { MockProvider, streamOptions, type LlmProvider } from "../src/llm";
import { ConversationStore } from "../src/store";
import { createDefaultTools } from "../src/tools/builtins";
import type { LlmMessage, LlmStreamEvent } from "../src/types";
import { readSse } from "./helpers";
import { startMockMcpServer } from "../scripts/mock-mcp-server.mjs";

const SECRET = "mcp-secret-value-9f3c2a";
const LLM_KEY = "llm-key-should-stay-out";
const DEMO_TOKEN = "demo-token-should-stay-out";

afterEach(async () => {
  await resetAppContext();
  delete process.env.MCP_TEST_SECRET;
  delete process.env.MCP_DEMO_TOKEN;
  delete process.env.LLM_API_KEY;
});

type Captured = { lines: string[]; restore: () => void };

function captureOutput(): Captured {
  const lines: string[] = [];
  const push = (chunk: unknown) => {
    if (typeof chunk === "string") lines.push(chunk);
    else if (Buffer.isBuffer(chunk)) lines.push(chunk.toString("utf8"));
    else lines.push(String(chunk));
  };
  const methods = ["log", "info", "warn", "error", "debug"] as const;
  const originals = methods.map((method) => console[method]);
  for (const method of methods) {
    console[method] = (...args: unknown[]) => {
      push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
    };
  }
  const stdout = process.stdout.write.bind(process.stdout);
  const stderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: unknown) => {
    push(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => {
    push(chunk);
    return true;
  }) as typeof process.stderr.write;
  return {
    lines,
    restore() {
      methods.forEach((method, index) => {
        console[method] = originals[index]!;
      });
      process.stdout.write = stdout;
      process.stderr.write = stderr;
    },
  };
}

class RecordingProvider implements LlmProvider {
  readonly id = "mock" as const;
  readonly model = null;
  readonly prompts: string[] = [];
  readonly seen: string[][] = [];
  #turn = 0;

  constructor(private readonly toolName: string | null) {}

  async *stream(messages: LlmMessage[], input?: AbortSignal): AsyncIterable<LlmStreamEvent> {
    const { tools = [] } = streamOptions(input);
    this.seen.push(tools.map((tool) => tool.name));
    this.prompts.push(JSON.stringify({ messages, tools }));
    const turn = this.#turn;
    this.#turn += 1;
    if (turn === 0 && this.toolName) {
      yield {
        type: "tool_call",
        index: 0,
        id: "call_mcp",
        name: this.toolName,
        arguments: this.toolName.endsWith("env_probe") ? "{}" : '{"message":"ping"}',
      };
      yield { type: "end", finishReason: "tool_calls" };
      return;
    }
    yield { type: "text", text: "Finished." };
    yield { type: "end", finishReason: "stop" };
  }
}

function chat(message: string, conversationId?: string): Promise<Response> {
  return postChat(
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, conversationId }),
    }),
  );
}

async function addConnector(input: {
  name: string;
  transport: "http" | "stdio";
  target: string;
  secretRef?: string;
}): Promise<{ id: string; body: string }> {
  const response = await createConnector(
    new Request("http://localhost/api/connectors", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
  const body = await response.text();
  expect(response.status, body).toBe(201);
  const parsed = JSON.parse(body) as { connector: { id: string } };
  return { id: parsed.connector.id, body };
}

async function listedConnectors(): Promise<string> {
  const response = await getConnectors();
  return response.text();
}

async function conversationBody(id: string): Promise<string> {
  const response = await readConversation(new Request(`http://localhost/api/conversations/${id}`), {
    params: Promise.resolve({ id }),
  });
  return response.text();
}

function conversationIdFrom(events: Array<{ event: string; data: unknown }>): string {
  const meta = events.find((event) => event.event === "meta");
  const id = (meta?.data as { conversationId?: string } | undefined)?.conversationId;
  if (!id) throw new Error("Missing conversation id");
  return id;
}

it("applies the connectors migration on a fresh database and again on reopen", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mockbot-connectors-"));
  try {
    const store = await ConversationStore.open(dir);
    const created = await store.createConnector({
      name: "Demo",
      transport: "http",
      target: "http://127.0.0.1:9/mcp",
      secretRef: "MCP_DEMO_TOKEN",
    });
    expect(created.secretRef).toBe("MCP_DEMO_TOKEN");
    expect(created.enabled).toBe(true);
    await store.close();

    const reopened = await ConversationStore.open(dir);
    const rows = await reopened.listConnectors();
    expect(rows.map((row) => row.id)).toEqual([created.id]);
    expect(JSON.stringify(rows)).not.toContain("demo-token");
    await reopened.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("applies migrations when the process cwd has no SQL files", async () => {
  const root = await mkdtemp(join(tmpdir(), "mockbot-cwd-"));
  const away = join(root, "away");
  await mkdir(away);
  const previous = process.cwd();
  try {
    process.chdir(away);
    const store = await ConversationStore.open(join(root, "data"));
    expect(await store.listConnectors()).toEqual([]);
    await store.close();
  } finally {
    process.chdir(previous);
    await rm(root, { recursive: true, force: true });
  }
});

it("rejects secret references that do not start with MCP_", async () => {
  process.env.LLM_API_KEY = LLM_KEY;
  process.env.GITHUB_TOKEN = "github-token-should-stay-out";
  const store = await ConversationStore.open();
  setAppContext({
    store,
    provider: new MockProvider({ delayMs: 0 }),
    tools: createDefaultTools({}),
  });
  try {
    for (const secretRef of ["LLM_API_KEY", "GITHUB_TOKEN", "PATH"]) {
      const response = await createConnector(
        new Request("http://localhost/api/connectors", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "Demo",
            transport: "http",
            target: "http://127.0.0.1:9/mcp",
            secretRef,
          }),
        }),
      );
      const body = await response.text();
      expect(response.status, body).toBe(400);
      expect(body).toContain("MCP_");
      expect(body).not.toContain(LLM_KEY);
      expect(body).not.toContain("github-token-should-stay-out");
    }
    expect(await store.listConnectors()).toEqual([]);
    const allowed = parseConnectorInput({
      name: "Demo",
      transport: "http",
      target: "http://127.0.0.1:9/mcp",
      secretRef: "MCP_DEMO_TOKEN",
    });
    expect(allowed.ok).toBe(true);
    if (allowed.ok) expect(allowed.value.secretRef).toBe("MCP_DEMO_TOKEN");
    const empty = parseConnectorInput({
      name: "Demo",
      transport: "http",
      target: "http://127.0.0.1:9/mcp",
      secretRef: "",
    });
    expect(empty.ok).toBe(true);
  } finally {
    delete process.env.GITHUB_TOKEN;
  }
});

it("keeps a connector secret out of the prompt, logs, traces, and client responses", async () => {
  process.env.MCP_TEST_SECRET = SECRET;
  const server = await startMockMcpServer({ leak: SECRET });
  const captured = captureOutput();
  const provider = new RecordingProvider("demo_echo");
  try {
    const store = await ConversationStore.open();
    setAppContext({ store, provider, tools: createDefaultTools({}) });
    const created = await addConnector({
      name: "Demo",
      transport: "http",
      target: server.url,
      secretRef: "MCP_TEST_SECRET",
    });
    const connectors = await listedConnectors();
    const response = await chat("Use the connector");
    const events = await readSse(response);
    const conversation = await conversationBody(conversationIdFrom(events));
    const prompts = provider.prompts.join("\n");
    const logs = captured.lines.join("\n");
    const visible = [
      created.body,
      connectors,
      JSON.stringify(events),
      conversation,
      prompts,
      logs,
    ].join("\n");

    expect(server.authorizations).toContain(`Bearer ${SECRET}`);
    expect(visible).not.toContain(SECRET);
    expect(visible).toContain("[redacted]");
    expect(prompts).toContain("demo_echo");
    expect(conversation).toContain("ping");
    expect(conversation).toContain("mock-mcp");
  } finally {
    captured.restore();
    await server.close();
  }
});

it("drops a removed connector's tools on the next turn and keeps the built-ins", async () => {
  const server = await startMockMcpServer();
  const provider = new RecordingProvider("demo_echo");
  try {
    const store = await ConversationStore.open();
    setAppContext({ store, provider, tools: createDefaultTools({}) });
    const created = await addConnector({
      name: "Demo",
      transport: "http",
      target: server.url,
    });
    const first = await readSse(await chat("First"));
    expect(provider.seen[0]).toEqual(
      expect.arrayContaining([
        "tool_search",
        "web_search",
        "web_fetch",
        "github",
        "google_calendar",
        "demo_echo",
      ]),
    );
    const result = first.find((event) => event.event === "tool_result");
    expect(result?.data).toMatchObject({ name: "demo_echo", status: "done" });
    expect(JSON.stringify(result?.data)).toContain("ping");

    const removed = await deleteConnector(
      new Request("http://localhost/api/connectors/" + created.id),
      {
        params: Promise.resolve({ id: created.id }),
      },
    );
    expect(removed.status).toBe(204);

    await readSse(await chat("Second", conversationIdFrom(first)));
    const nextTurn = provider.seen.at(-1) ?? [];
    expect(nextTurn).not.toContain("demo_echo");
    expect(nextTurn).not.toContain("demo_env_probe");
    expect(nextTurn).toEqual(
      expect.arrayContaining([
        "tool_search",
        "web_search",
        "web_fetch",
        "github",
        "google_calendar",
      ]),
    );
  } finally {
    await server.close();
  }
});

it("drops a disabled connector's tools on the next turn", async () => {
  const server = await startMockMcpServer();
  const provider = new RecordingProvider(null);
  try {
    const store = await ConversationStore.open();
    setAppContext({ store, provider, tools: createDefaultTools({}) });
    const created = await addConnector({
      name: "Demo",
      transport: "http",
      target: server.url,
    });
    await readSse(await chat("First"));
    expect(provider.seen[0]).toContain("demo_echo");

    const disabled = await patchConnector(
      new Request("http://localhost/api/connectors/" + created.id, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      }),
      { params: Promise.resolve({ id: created.id }) },
    );
    expect(disabled.status).toBe(200);

    await readSse(await chat("Second"));
    expect(provider.seen[1]).not.toContain("demo_echo");
    expect(provider.seen[1]).toContain("web_search");
  } finally {
    await server.close();
  }
});

it("calls the mock server from the live mock provider and stops after removal", async () => {
  const server = await startMockMcpServer();
  try {
    const store = await ConversationStore.open();
    setAppContext({
      store,
      provider: new MockProvider({ delayMs: 0, chunkSize: 80 }),
      tools: createDefaultTools({}),
    });
    const created = await addConnector({
      name: "Demo",
      transport: "http",
      target: server.url,
      secretRef: undefined,
    });
    const called = await readSse(
      await chat('Call demo_echo {"message":"hello from the connector"}'),
    );
    const start = called.find((event) => event.event === "tool_start");
    expect(start?.data).toMatchObject({ name: "demo_echo" });
    const args = called.find((event) => event.event === "tool_args");
    expect(JSON.stringify(args?.data)).toContain("hello from the connector");
    const result = called.find(
      (event) =>
        event.event === "tool_result" && event.data && (event.data as { status?: string }).status,
    );
    expect(JSON.stringify(result?.data)).toContain("hello from the connector");
    expect(JSON.stringify(result?.data)).toContain("mock-mcp");
    const text = called
      .filter((event) => event.event === "delta")
      .map((event) => String((event.data as { text?: string }).text ?? ""))
      .join("");
    expect(text).toContain("I called demo_echo");
    expect(text).toContain("hello from the connector");

    const removed = await deleteConnector(
      new Request("http://localhost/api/connectors/" + created.id),
      {
        params: Promise.resolve({ id: created.id }),
      },
    );
    expect(removed.status).toBe(204);
    const gone = await readSse(
      await chat('Call demo_echo {"message":"still there?"}', conversationIdFrom(called)),
    );
    expect(gone.some((event) => event.event === "tool_start")).toBe(false);
    const reply = gone
      .filter((event) => event.event === "delta")
      .map((event) => String((event.data as { text?: string }).text ?? ""))
      .join("");
    expect(reply).toContain("not in this turn's tool list");
  } finally {
    await server.close();
  }
});

it("passes only the referenced secret into a stdio server", async () => {
  process.env.LLM_API_KEY = LLM_KEY;
  process.env.MCP_DEMO_TOKEN = DEMO_TOKEN;
  const provider = new RecordingProvider("demo_env_probe");
  const store = await ConversationStore.open();
  setAppContext({ store, provider, tools: createDefaultTools({}) });
  const script = join(process.cwd(), "scripts/mock-mcp-server.mjs");
  await addConnector({
    name: "Demo",
    transport: "stdio",
    target: `${process.execPath} ${script}`,
    secretRef: "MCP_DEMO_TOKEN",
  });
  const events = await readSse(await chat("Probe"));
  const result = events.find((event) => event.event === "tool_result");
  expect(result?.data).toMatchObject({
    name: "demo_env_probe",
    status: "done",
    output: '{"llm":"absent","demo":"present"}',
  });
  const visible = [JSON.stringify(events), provider.prompts.join("\n")].join("\n");
  expect(visible).not.toContain(LLM_KEY);
  expect(visible).not.toContain(DEMO_TOKEN);
});

it("does not invent a tool call for an ordinary mock message", async () => {
  const server = await startMockMcpServer();
  try {
    const store = await ConversationStore.open();
    setAppContext({
      store,
      provider: new MockProvider({ delayMs: 0, chunkSize: 40 }),
      tools: createDefaultTools({}),
    });
    await addConnector({ name: "Demo", transport: "http", target: server.url });
    const events = await readSse(await chat("Say hello"));
    expect(events.some((event) => event.event === "tool_start")).toBe(false);
  } finally {
    await server.close();
  }
});
