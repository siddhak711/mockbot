import { createServer, type IncomingMessage } from "node:http";
import { once } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { POST as createAgent } from "../app/api/agents/route";
import { POST as postChat } from "../app/api/chat/route";
import { GET as readRun } from "../app/api/runs/[id]/route";
import { resetAppContext, setAppContext } from "../src/context";
import { MockProvider, selectProvider, type LlmProvider } from "../src/llm";
import { runRoutineTurn } from "../src/routines/turn";
import { RunLog, listRunEvents, runTotals } from "../src/runs/events";
import { redactSecrets } from "../src/runs/redact";
import { ConversationStore } from "../src/store";
import type { LlmMessage, LlmStreamEvent } from "../src/types";
import { deltas, readSse } from "./helpers";

afterEach(async () => {
  await resetAppContext();
});

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

it("redacts api keys, passwords, tokens, and auth headers", () => {
  const apiKey = `sk-${"a".repeat(24)}`;
  const bearer = "b".repeat(32);
  const password = "hunter2hunter2";
  const input = JSON.stringify({
    messages: [
      {
        role: "user",
        content: `lookup ${apiKey} Authorization: Bearer ${bearer}`,
      },
    ],
    password,
    token: "sess-token-value",
    note: `password=${password}`,
  });
  const redacted = redactSecrets(input);
  expect(redacted).not.toContain(apiKey);
  expect(redacted).not.toContain(bearer);
  expect(redacted).not.toContain(password);
  expect(redacted).not.toContain("sess-token-value");
  expect(redacted).toContain("[redacted]");
  expect(redactSecrets("token counts are 12 and token: 3")).toBe(
    "token counts are 12 and token: 3",
  );

  const nested = JSON.stringify({
    messages: [
      {
        role: "assistant",
        tool_calls: [
          {
            function: {
              name: "web_search",
              arguments: JSON.stringify({ query: `lookup ${apiKey}`, password }),
            },
          },
        ],
      },
    ],
  });
  const nestedRedacted = redactSecrets(nested);
  expect(nestedRedacted).not.toContain(apiKey);
  expect(nestedRedacted).not.toContain(password);

  const url = `https://example.com/search?q=${encodeURIComponent(`lookup ${apiKey} Authorization: Bearer ${bearer}`)}`;
  const urlRedacted = redactSecrets(url);
  expect(urlRedacted).not.toContain(apiKey);
  expect(urlRedacted).not.toContain(bearer);
});

it("writes ordered model and tool events for an agent turn and hides secrets", async () => {
  const apiKey = `sk-${"c".repeat(24)}`;
  const bearer = "d".repeat(32);
  const password = "s3cret-password";
  const store = await ConversationStore.open();
  setAppContext({
    store,
    provider: selectProvider({ LLM_PROVIDER: "mock", MOCK_STREAM_DELAY_MS: "0" }),
  });
  const message = `Call web_search ${JSON.stringify({
    query: `lookup ${apiKey} Authorization: Bearer ${bearer}`,
    password,
  })}`;

  const response = await postChat(
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    }),
  );
  const events = await readSse(response);
  const meta = events.find((event) => event.event === "meta");
  const runId = (meta?.data as { runId?: string } | undefined)?.runId;
  expect(runId).toBeTruthy();

  const rows = await listRunEvents(store.connection, runId!);
  expect(rows.map((row) => row.seq)).toEqual(rows.map((_, index) => index + 1));
  expect(rows[0]).toMatchObject({ type: "event" });
  expect(rows.at(-1)).toMatchObject({ type: "event" });

  const models = rows.filter((row) => row.type === "model");
  const tools = rows.filter((row) => row.type === "tool");
  expect(models.length).toBeGreaterThan(0);
  expect(tools.length).toBeGreaterThan(0);
  for (const row of [...models, ...tools]) {
    expect(row.tokens).toEqual(expect.any(Number));
    expect(row.costUsd).toEqual(expect.any(Number));
    expect(row.ms).toEqual(expect.any(Number));
    expect(row.tokens).toBeGreaterThan(0);
    expect(row.ms).toBeGreaterThanOrEqual(0);
  }

  const stored = JSON.stringify(rows);
  expect(stored).not.toContain(apiKey);
  expect(stored).not.toContain(bearer);
  expect(stored).not.toContain(password);
  expect(stored).toContain("[redacted]");

  const totals = runTotals(rows);
  expect(totals.tokens).toBe(models.concat(tools).reduce((sum, row) => sum + (row.tokens ?? 0), 0));
  expect(totals.costUsd).toBe(0);
  expect(totals.ms).toBe(models.concat(tools).reduce((sum, row) => sum + (row.ms ?? 0), 0));

  const loaded = await readRun(new Request("http://localhost/api/runs/" + runId), {
    params: Promise.resolve({ id: runId! }),
  });
  expect(loaded.status).toBe(200);
  const body = (await loaded.json()) as { totals: { tokens: number }; events: unknown[] };
  expect(body.events).toHaveLength(rows.length);
  expect(body.totals.tokens).toBe(totals.tokens);
});

it("stores provider usage and a priced cost on a model event", async () => {
  const seen: { body?: string } = {};
  const server = createServer(async (request, response) => {
    seen.body = await readBody(request);
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n');
    response.write(
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":11,"completion_tokens":4,"total_tokens":15}}\n\n',
    );
    response.write("data: [DONE]\n\n");
    response.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP port");

  try {
    const store = await ConversationStore.open();
    setAppContext({
      store,
      provider: selectProvider({
        LLM_PROVIDER: "openai",
        LLM_API_KEY: "sk-live-test-key-not-logged",
        LLM_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
        LLM_MODEL: "gpt-4o-mini",
      }),
    });
    const response = await postChat(
      new Request("http://localhost/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "Say hi" }),
      }),
    );
    const streamed = await readSse(response);
    const runId = (streamed.find((event) => event.event === "meta")?.data as { runId?: string })
      .runId;
    expect(runId).toBeTruthy();
    const forwarded = JSON.parse(seen.body ?? "{}") as {
      stream_options?: { include_usage?: boolean };
    };
    expect(forwarded.stream_options?.include_usage).toBe(true);

    const rows = await listRunEvents(store.connection, runId!);
    const model = rows.find((row) => row.type === "model");
    expect(model?.tokens).toBe(15);
    expect(model?.costUsd).toBeGreaterThan(0);
    expect(model?.ms).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(rows)).not.toContain("sk-live-test-key-not-logged");
  } finally {
    server.close();
  }
});

it("finishes the chat turn and closes the stream when run_events inserts throw", async () => {
  const store = await ConversationStore.open();
  const db = store.connection;
  const query = db.query.bind(db);
  db.query = (async (text: string, params?: readonly unknown[]) => {
    if (text.includes("INSERT INTO run_events")) throw new Error("run_events down");
    return query(text, params);
  }) as typeof db.query;
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  setAppContext({
    store,
    provider: selectProvider({ LLM_PROVIDER: "mock", MOCK_STREAM_DELAY_MS: "0" }),
  });
  try {
    const response = await postChat(
      new Request("http://localhost/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "Hello from a broken log" }),
      }),
    );
    const events = await Promise.race([
      readSse(response),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("SSE stream did not close")), 5_000);
      }),
    ]);
    expect(response.body?.locked).toBe(true);
    expect(events.some((event) => event.event === "done")).toBe(true);
    expect(events.some((event) => event.event === "error")).toBe(false);
    expect(deltas(events)).toContain("mock reply");
    expect(JSON.stringify(events)).not.toContain("run_events down");
    expect(logged).toHaveBeenCalled();
  } finally {
    logged.mockRestore();
  }
});

it("appends a model-route event with run_id and seq, and does not reject when the insert throws", async () => {
  const store = await ConversationStore.open();
  await RunLog.recordModelRoute(store.connection, {
    runId: "run_route",
    tier: "cheap",
    reason: "chat",
    model: "deepseek/deepseek-v4.1-flash",
    costUsd: 0.0000014,
    inputTokens: 10,
    outputTokens: 4,
  });
  await RunLog.recordModelRoute(store.connection, {
    runId: "run_route",
    tier: "strong",
    reason: "retry",
    model: "deepseek/deepseek-chat",
    costUsd: 0.002,
    inputTokens: 3,
    outputTokens: 1,
  });
  const rows = await listRunEvents(store.connection, "run_route");
  expect(rows.map((row) => row.seq)).toEqual([1, 2]);
  expect(rows[0]).toMatchObject({
    runId: "run_route",
    type: "event",
    tokens: 14,
    ms: null,
  });
  expect(rows[0]?.costUsd).toBeCloseTo(0.0000014, 8);
  expect(rows[0]?.input).toContain('"name":"model.route"');
  expect(rows[0]?.input).toContain('"tier":"cheap"');
  expect(rows[1]?.input).toContain('"reason":"retry"');

  const db = store.connection;
  db.query = (async () => {
    throw new Error("run_events down");
  }) as typeof db.query;
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await expect(
      RunLog.recordModelRoute(db, {
        tier: "cheap",
        reason: "chat",
        model: "mock",
        costUsd: 0,
        inputTokens: 1,
        outputTokens: 1,
      }),
    ).resolves.toBeUndefined();
  } finally {
    logged.mockRestore();
  }
});

it("records the model row when a routine stream throws", async () => {
  const store = await ConversationStore.open();
  const conversation = await store.createConversation("Routine");
  const provider: LlmProvider = {
    id: "mock",
    model: "gpt-4o-mini",
    async *stream(): AsyncIterable<LlmStreamEvent> {
      yield { type: "text", text: "partial" };
      throw new Error("upstream unavailable");
    },
  };

  await expect(
    runRoutineTurn({
      store,
      provider,
      conversationId: conversation.id,
      prompt: "Summarize today",
      runId: "run_routine_fail",
    }),
  ).rejects.toThrow("upstream unavailable");

  const rows = await listRunEvents(store.connection, "run_routine_fail");
  const model = rows.find((row) => row.type === "model");
  expect(rows.map((row) => row.type)).toEqual(["event", "model", "error", "event"]);
  expect(model?.input).toContain("Summarize today");
  expect(model?.output).toContain("partial");
  expect(model?.tokens).toBeGreaterThan(0);
  expect(model?.costUsd).toEqual(expect.any(Number));
  expect(model?.costUsd).toBeGreaterThan(0);
  expect(model?.ms).toEqual(expect.any(Number));
});

it("writes the parent model row before delegate rows", async () => {
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
      tools: (messages: LlmMessage[]) => {
        const system = messages.find((message) => message.role === "system")?.content ?? "";
        if (system.includes("delegation: child")) {
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
      reply: (messages: LlmMessage[]) => {
        const system = messages.find((message) => message.role === "system")?.content ?? "";
        if (system.includes("delegation: child")) return "Notes received";
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

  const response = await postChat(
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Ask the researcher" }),
    }),
  );
  const events = await readSse(response);
  expect(events.some((event) => event.event === "error")).toBe(false);
  const runId = (events.find((event) => event.event === "meta")?.data as { runId?: string }).runId;
  expect(runId).toBeTruthy();

  const rows = await listRunEvents(store.connection, runId!);
  const parent = rows.find(
    (row) => row.type === "model" && row.input?.includes("Ask the researcher"),
  );
  const child = rows.find((row) => row.type === "model" && row.input?.includes("Read the notes"));
  const delegate = rows.find(
    (row) => row.type === "tool" && row.input?.includes('"name":"delegate"'),
  );
  const computer = rows.find(
    (row) => row.type === "tool" && row.input?.includes('"name":"use_computer"'),
  );
  expect(parent?.seq).toEqual(expect.any(Number));
  expect(child?.seq).toEqual(expect.any(Number));
  expect(delegate?.seq).toEqual(expect.any(Number));
  expect(computer?.seq).toEqual(expect.any(Number));
  expect(parent!.seq).toBeLessThan(child!.seq);
  expect(parent!.seq).toBeLessThan(computer!.seq);
  expect(parent!.seq).toBeLessThan(delegate!.seq);
  expect(rows.find((row) => row.type === "model")?.seq).toBe(parent!.seq);
});
