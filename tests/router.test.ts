import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { POST } from "../app/api/chat/route";
import { resetAppContext, setAppContext } from "../src/context";
import { MockProvider, selectProvider } from "../src/llm";
import {
  DEFAULT_ROUTER_CONFIG,
  describeTurn,
  formatCostReport,
  loadRouterConfig,
  messagesForTurn,
  pickModel,
  RoutingProvider,
  runRoutedSample,
  SAMPLE_TURNS,
  type RouterTurn,
} from "../src/model-router";
import {
  clearRouteLogs,
  clearRunEventSchemaCache,
  logModelRoute,
  recentRouteLogs,
} from "../src/run-events";
import type { Sql } from "../src/db/sql";
import { SandboxTurnProvider } from "../src/sandbox/turn";
import { ConversationStore } from "../src/store";
import { emptyTrace } from "../src/trace";
import { buildModelInput } from "../src/turn";
import { createDefaultTools } from "../src/tools/builtins";
import { readSse } from "./helpers";

afterEach(async () => {
  clearRouteLogs();
  clearRunEventSchemaCache();
  await resetAppContext();
});

const RULES: Array<{ turn: RouterTurn; tier: "cheap" | "strong"; reason: string }> = [
  { turn: { text: "Hey, what can you help me with today?" }, tier: "cheap", reason: "chat" },
  {
    turn: {
      text: "Look this up",
      toolCalls: [{ name: "web_search", arguments: '{"query":"mockbot"}' }],
    },
    tier: "cheap",
    reason: "tool",
  },
  {
    turn: { text: 'Call web_search {"query":"mockbot"}' },
    tier: "cheap",
    reason: "tool",
  },
  {
    turn: { text: "What is on my calendar this afternoon?" },
    tier: "cheap",
    reason: "chat",
  },
  {
    turn: {
      text: "What is on my calendar this afternoon?",
      toolCalls: [{ name: "google_calendar", arguments: '{"action":"list"}' }],
    },
    tier: "cheap",
    reason: "tool",
  },
  {
    turn: { text: "Write a plan for moving the agent loop off the request thread." },
    tier: "strong",
    reason: "plan",
  },
  {
    turn: { text: "Implement the parser in TypeScript and add unit tests." },
    tier: "strong",
    reason: "code",
  },
  {
    turn: {
      text: "Hello",
      toolCalls: [{ name: "exec", arguments: '{"command":"npm test"}' }],
    },
    tier: "strong",
    reason: "code",
  },
  {
    turn: {
      text: "Create a file named notes.txt that says hello",
    },
    tier: "strong",
    reason: "code",
  },
  {
    turn: { text: "Read the file named notes.txt" },
    tier: "cheap",
    reason: "tool",
  },
  {
    turn: { text: "Hey", retryAfterFailure: true },
    tier: "strong",
    reason: "retry",
  },
];

it("routes an inline-code question cheap and an explicit run request strong", () => {
  expect(pickModel({ text: "what does `npm ci` do?" })).toMatchObject({
    tier: "cheap",
    reason: "chat",
  });
  expect(pickModel({ text: "what does `npm run build` do?" })).toMatchObject({
    tier: "cheap",
    reason: "chat",
  });
  expect(pickModel({ text: "run npm ci" })).toMatchObject({
    tier: "strong",
    reason: "code",
  });
  expect(pickModel({ text: "run `npm ci`" })).toMatchObject({
    tier: "strong",
    reason: "code",
  });
});

it("routes each rule to the cheap or strong open-weights tier", () => {
  const config = loadRouterConfig({ LLM_BASE_URL: "https://openrouter.ai/api/v1" });
  expect(config.cheap.id).toBe(DEFAULT_ROUTER_CONFIG.cheap.id);
  expect(config.strong.id).toBe(DEFAULT_ROUTER_CONFIG.strong.id);
  for (const rule of RULES) {
    const decision = pickModel(rule.turn, config);
    expect(decision, rule.turn.text).toMatchObject({ tier: rule.tier, reason: rule.reason });
    expect(decision.model).toBe(rule.tier === "cheap" ? config.cheap.id : config.strong.id);
  }
});

it("reads tier ids and prices from env and refuses a closed model", () => {
  const config = loadRouterConfig({
    MODEL_TIER_CHEAP: "qwen/qwen3-coder",
    MODEL_TIER_STRONG: "moonshotai/kimi-k2",
    MODEL_TIER_CHEAP_INPUT_USD_PER_MTOK: "0.2",
    MODEL_TIER_CHEAP_OUTPUT_USD_PER_MTOK: "0.4",
    MODEL_TIER_STRONG_INPUT_USD_PER_MTOK: "1",
    MODEL_TIER_STRONG_OUTPUT_USD_PER_MTOK: "3",
  });
  expect(pickModel({ text: "hello" }, config)).toMatchObject({
    tier: "cheap",
    model: "qwen/qwen3-coder",
  });
  expect(pickModel({ text: "Write a plan for the rollout" }, config)).toMatchObject({
    tier: "strong",
    model: "moonshotai/kimi-k2",
  });
  expect(config.cheap.inputUsdPerMillion).toBe(0.2);
  expect(config.strong.outputUsdPerMillion).toBe(3);
  expect(() => loadRouterConfig({ MODEL_TIER_CHEAP: "openai/gpt-4o-mini" })).toThrow(
    /open-weights/,
  );
  expect(() => loadRouterConfig({ MODEL_TIER_STRONG: "anthropic/claude-opus-4" })).toThrow(
    /open-weights/,
  );
  expect(() => loadRouterConfig({ MODEL_TIER_CHEAP_INPUT_USD_PER_MTOK: "-1" })).toThrow(/price/i);
});

it("keeps a retry on the strong tier after the failed tool is stored as assistant text", async () => {
  const rebuilt = describeTurn([
    { role: "user", content: "Look up the grove notes" },
    {
      role: "assistant",
      content: "Previous tool activity:\nweb_search (error): Unknown tool",
      failed: true,
    },
    { role: "user", content: "Please try again" },
  ]);
  expect(pickModel(rebuilt)).toMatchObject({ tier: "strong", reason: "retry" });

  const store = await ConversationStore.open();
  const conversation = await store.createConversation("retry");
  await store.addMessage(conversation.id, "user", "Look up the grove notes");
  const assistant = await store.addMessage(
    conversation.id,
    "assistant",
    "I could not look that up.",
    {
      ...emptyTrace(),
      started: true,
      role: "assistant",
      ended: true,
      text: "I could not look that up.",
      route: { tier: "cheap", reason: "tool", model: DEFAULT_ROUTER_CONFIG.cheap.id },
    },
  );
  await store.saveToolCall({
    id: "call_saved",
    conversationId: conversation.id,
    messageId: assistant.id,
    name: "web_search",
    arguments: "{}",
    status: "error",
    output: "Unknown tool",
  });
  await store.addMessage(conversation.id, "user", "Please try again");
  const prepared = await buildModelInput({ store, conversationId: conversation.id });
  expect(prepared).not.toBeNull();
  expect(pickModel(describeTurn(prepared!.messages), DEFAULT_ROUTER_CONFIG)).toMatchObject({
    tier: "strong",
    reason: "retry",
  });

  await store.addMessage(conversation.id, "user", "Never mind, how are you?");
  const next = await buildModelInput({ store, conversationId: conversation.id });
  expect(pickModel(describeTurn(next!.messages), DEFAULT_ROUTER_CONFIG)).toMatchObject({
    tier: "cheap",
    reason: "chat",
  });
});

it("records the chosen tier on the log line and on the saved turn", async () => {
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  try {
    const store = await ConversationStore.open();
    setAppContext({
      store,
      provider: new RoutingProvider({
        inner: new MockProvider({ delayMs: 0, chunkSize: 80 }),
        config: DEFAULT_ROUTER_CONFIG,
      }),
    });
    const response = await POST(
      new Request("http://localhost/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "Hello there" }),
      }),
    );
    await readSse(response);
    expect(info.mock.calls.some((call) => String(call[0]).includes("tier=cheap"))).toBe(true);
    expect(info.mock.calls.some((call) => String(call[0]).includes("reason=chat"))).toBe(true);
    const loaded = await store.getConversation((await store.listConversations())[0]!.id);
    expect(loaded?.messages[1]?.trace?.route).toMatchObject({
      tier: "cheap",
      reason: "chat",
      model: DEFAULT_ROUTER_CONFIG.cheap.id,
    });
  } finally {
    info.mockRestore();
  }
});

it("keeps both tiers on LLM_MODEL when tiers are unset and the base URL is not OpenRouter", async () => {
  const config = loadRouterConfig({
    LLM_MODEL: "gpt-4o-mini",
    LLM_BASE_URL: "https://api.openai.com/v1",
  });
  expect(config.cheap.id).toBe("gpt-4o-mini");
  expect(config.strong.id).toBe("gpt-4o-mini");
  expect(config.cheap.inputUsdPerMillion).toBe(0);
  expect(config.strong.outputUsdPerMillion).toBe(0);
  expect(pickModel({ text: "Hey, what can you help me with today?" }, config).model).toBe(
    "gpt-4o-mini",
  );
  expect(pickModel({ text: "Implement the parser in TypeScript" }, config).model).toBe(
    "gpt-4o-mini",
  );
  const openRouter = loadRouterConfig({
    LLM_MODEL: "gpt-4o-mini",
    LLM_BASE_URL: "https://openrouter.ai/api/v1",
  });
  expect(openRouter.cheap.id).toBe(DEFAULT_ROUTER_CONFIG.cheap.id);
  expect(openRouter.strong.id).toBe(DEFAULT_ROUTER_CONFIG.strong.id);
  expect(openRouter.cheap.inputUsdPerMillion).toBe(DEFAULT_ROUTER_CONFIG.cheap.inputUsdPerMillion);
  expect(openRouter.strong.outputUsdPerMillion).toBe(
    DEFAULT_ROUTER_CONFIG.strong.outputUsdPerMillion,
  );

  const provider = new RoutingProvider({
    inner: new MockProvider({ delayMs: 0, chunkSize: 80 }),
    config,
  });
  for await (const _event of provider.stream([{ role: "user", content: "Hello there" }])) {
    // The fallback id has to be accepted by the constructor and sent as the model.
  }
  expect(provider.lastDecision).toMatchObject({ tier: "cheap", model: "gpt-4o-mini" });
  expect(
    () =>
      new RoutingProvider({
        inner: new MockProvider({ delayMs: 0, chunkSize: 80 }),
        config: {
          cheap: { id: "openai/gpt-4o", inputUsdPerMillion: 1, outputUsdPerMillion: 1 },
          strong: DEFAULT_ROUTER_CONFIG.strong,
        },
      }),
  ).toThrow(/open-weights/);
});

it("escalates the next round after a failed tool, and a later try-again", () => {
  const failedRound = describeTurn([
    { role: "user", content: "Look up the grove notes" },
    {
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "web_search", arguments: '{"query":"grove"}' },
        },
      ],
    },
    { role: "tool", tool_call_id: "call_1", content: 'Unknown tool "web_search".', failed: true },
  ]);
  expect(pickModel(failedRound)).toMatchObject({ tier: "strong", reason: "retry" });

  const tryAgain = describeTurn([
    { role: "user", content: "Look up the grove notes" },
    { role: "tool", tool_call_id: "call_1", content: "Error", failed: true },
    { role: "assistant", content: "I could not look that up." },
    { role: "user", content: "Please try again" },
  ]);
  expect(pickModel(tryAgain)).toMatchObject({ tier: "strong", reason: "retry" });

  const nextTopic = describeTurn([
    { role: "user", content: "Look up the grove notes" },
    { role: "tool", tool_call_id: "call_1", content: "Error", failed: true },
    { role: "user", content: "Never mind, how are you?" },
  ]);
  expect(pickModel(nextTopic)).toMatchObject({ tier: "cheap", reason: "chat" });
});

it("spends less on a sample multi-turn run than an all-strong baseline", async () => {
  const provider = new RoutingProvider({
    inner: new MockProvider({ delayMs: 0, chunkSize: 64 }),
    config: DEFAULT_ROUTER_CONFIG,
  });
  const report = await runRoutedSample(provider);
  console.log(formatCostReport(report));

  expect(report.turns.map((turn) => turn.reason)).toEqual([
    "chat",
    "tool",
    "tool",
    "plan",
    "code",
    "retry",
  ]);
  expect(report.turns.map((turn) => turn.tier)).toEqual([
    "cheap",
    "cheap",
    "cheap",
    "strong",
    "strong",
    "strong",
  ]);
  for (const turn of report.turns) {
    expect(turn.outputTokens).toBeGreaterThan(0);
    expect(turn.costUsd).toBeGreaterThan(0);
    if (turn.tier === "cheap") expect(turn.costUsd).toBeLessThan(turn.strongUsd);
    if (turn.tier === "strong") expect(turn.costUsd).toBeCloseTo(turn.strongUsd, 10);
  }
  expect(report.routedUsd).toBeLessThan(report.allStrongUsd);
  expect(report.savingsUsd).toBeCloseTo(report.allStrongUsd - report.routedUsd, 10);
  expect(report.savingsPercent).toBeGreaterThan(0);
  expect(SAMPLE_TURNS).toHaveLength(report.turns.length);
  expect(messagesForTurn(SAMPLE_TURNS[0]!).at(-1)?.role).toBe("user");
});

it("logs the tier and cost to run_events, and no-ops when the table is absent", async () => {
  const store = await ConversationStore.open();
  const counted = countSchemaQueries(store.connection);
  const event = {
    id: "route_test",
    kind: "model.route" as const,
    tier: "cheap" as const,
    reason: "chat" as const,
    model: DEFAULT_ROUTER_CONFIG.cheap.id,
    costUsd: 0.00001234,
    inputTokens: 12,
    outputTokens: 40,
    conversationId: "conv_test",
  };

  expect(await logModelRoute(event, counted.db)).toBe("noop");
  expect(await logModelRoute(event, counted.db)).toBe("noop");
  expect(counted.schemaQueries).toBe(1);
  expect(recentRouteLogs()).toEqual([event, event]);
  const missing = await store.connection.query<{ rel: string | null }>(
    `SELECT to_regclass('public.run_events') AS rel`,
  );
  expect(missing.rows[0]?.rel ?? null).toBeNull();

  clearRunEventSchemaCache();
  await store.connection.exec(`
    CREATE TABLE run_events (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      tier TEXT,
      model TEXT,
      cost_usd DOUBLE PRECISION,
      payload JSONB,
      conversation_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  const beforeInsert = counted.schemaQueries;
  expect(await logModelRoute({ ...event, id: "route_test_2" }, counted.db)).toBe("logged");
  expect(await logModelRoute({ ...event, id: "route_test_2b" }, counted.db)).toBe("logged");
  expect(counted.schemaQueries - beforeInsert).toBe(2);
  const rows = await store.connection.query<{
    tier: string;
    model: string;
    cost_usd: number;
    payload: { costUsd?: number; tier?: string };
    conversation_id: string;
  }>(`SELECT tier, model, cost_usd, payload, conversation_id FROM run_events ORDER BY id`);
  expect(rows.rows).toEqual([
    {
      tier: "cheap",
      model: DEFAULT_ROUTER_CONFIG.cheap.id,
      cost_usd: 0.00001234,
      payload: expect.objectContaining({ tier: "cheap", costUsd: 0.00001234 }),
      conversation_id: "conv_test",
    },
    {
      tier: "cheap",
      model: DEFAULT_ROUTER_CONFIG.cheap.id,
      cost_usd: 0.00001234,
      payload: expect.objectContaining({ tier: "cheap", costUsd: 0.00001234 }),
      conversation_id: "conv_test",
    },
  ]);

  clearRunEventSchemaCache();
  await store.connection.exec(`DROP TABLE run_events`);
  await store.connection.exec(`CREATE TABLE run_events (id TEXT PRIMARY KEY, note TEXT NOT NULL)`);
  expect(await logModelRoute({ ...event, id: "route_test_3" }, counted.db)).toBe("noop");
  const notes = await store.connection.query(`SELECT id FROM run_events`);
  expect(notes.rows).toEqual([]);

  const other = await ConversationStore.open();
  await other.connection.exec(`
    CREATE TABLE run_events (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      payload JSONB
    );
  `);
  expect(await logModelRoute({ ...event, id: "route_other_db" }, other.connection)).toBe("logged");
  const otherRows = await other.connection.query<{ id: string }>(`SELECT id FROM run_events`);
  expect(otherRows.rows).toEqual([{ id: "route_other_db" }]);
});

it("sends the cheap tier for chat and the strong tier after a failed tool", async () => {
  const models: string[] = [];
  const server = createServer(async (request, response) => {
    const body = JSON.parse(await readBody(request)) as { model?: string };
    models.push(body.model ?? "");
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    if (models.length === 1) {
      writeSse(response, {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_missing",
                  type: "function",
                  function: { name: "missing_tool", arguments: "{}" },
                },
              ],
            },
          },
        ],
      });
      writeSse(response, { choices: [{ finish_reason: "tool_calls", delta: {} }] });
    } else {
      writeSse(response, { choices: [{ delta: { content: "Recovered." } }] });
      writeSse(response, { choices: [{ finish_reason: "stop", delta: {} }] });
    }
    response.end("data: [DONE]\n\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP port");

  try {
    const store = await ConversationStore.open();
    setAppContext({
      store,
      tools: createDefaultTools({}),
      provider: new RoutingProvider({
        inner: selectProvider({
          LLM_PROVIDER: "openai",
          LLM_API_KEY: "sk-test",
          LLM_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
          LLM_MODEL: "openai/gpt-4o-mini",
        }),
        db: store.connection,
        config: DEFAULT_ROUTER_CONFIG,
      }),
    });
    const response = await POST(
      new Request("http://localhost/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "Look up the grove notes" }),
      }),
    );
    const events = await readSse(response);
    expect(events.some((event) => event.event === "error")).toBe(false);
    expect(models).toEqual([DEFAULT_ROUTER_CONFIG.cheap.id, DEFAULT_ROUTER_CONFIG.strong.id]);
    expect(models).not.toContain("openai/gpt-4o-mini");
    const logged = recentRouteLogs();
    expect(logged.map((entry) => entry.tier)).toEqual(["cheap", "strong"]);
    expect(logged.every((entry) => entry.costUsd > 0)).toBe(true);
    expect(logged[0]?.conversationId).toBeTruthy();
  } finally {
    server.close();
  }
});

it("keeps routing when the sandbox provider wraps the router", async () => {
  const routed = new RoutingProvider({
    inner: new MockProvider({ delayMs: 0, chunkSize: 80 }),
    config: DEFAULT_ROUTER_CONFIG,
  });
  const sandbox = new SandboxTurnProvider({ inner: routed, delayMs: 0 });
  for await (const _event of sandbox.stream([{ role: "user", content: "Hello there" }])) {
    // Consume the mock reply.
  }
  expect(routed.lastDecision).toMatchObject({ tier: "cheap", reason: "chat" });
  expect(recentRouteLogs()[0]?.tier).toBe("cheap");
});

function countSchemaQueries(inner: Sql): { db: Sql; schemaQueries: number } {
  const counted = { schemaQueries: 0 };
  const db: Sql = {
    driver: inner.driver,
    async query(text, params) {
      if (text.includes("to_regclass") || text.includes("information_schema")) {
        counted.schemaQueries += 1;
      }
      return inner.query(text, params);
    },
    exec: (script) => inner.exec(script),
    transaction: (fn) => inner.transaction(fn),
    close: () => inner.close(),
  };
  return {
    db,
    get schemaQueries() {
      return counted.schemaQueries;
    },
  };
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function writeSse(response: ServerResponse, payload: unknown): void {
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}
