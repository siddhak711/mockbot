import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { withAgentMock } from "../src/agents/mock-script";
import { POST as createAgent } from "../app/api/agents/route";
import { POST } from "../app/api/chat/route";
import { streamChatTurn } from "../src/chat";
import { resetAppContext, setAppContext } from "../src/context";
import { MockProvider, selectProvider, type LlmProvider } from "../src/llm";
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
  streamDecision,
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
import { ApprovalGate } from "../src/tools/approval";
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
  expect(pickModel({ text: "run a search" })).toMatchObject({
    tier: "cheap",
    reason: "chat",
  });
  expect(pickModel({ text: "run through the notes" })).toMatchObject({
    tier: "cheap",
    reason: "chat",
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
  const capped = loadRouterConfig({
    LLM_BASE_URL: "https://openrouter.ai/api/v1",
    MODEL_TIER_CHEAP_MAX_TOKENS: "1024",
    MODEL_TIER_STRONG_MAX_TOKENS: "2048",
  });
  expect(capped.cheap.maxTokens).toBe(1024);
  expect(capped.strong.maxTokens).toBe(2048);
  expect(DEFAULT_ROUTER_CONFIG.strong.maxTokens).toBeLessThan(65536);
  expect(() => loadRouterConfig({ MODEL_TIER_STRONG_MAX_TOKENS: "65536" })).toThrow(/16384/);
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
    const routed = new RoutingProvider({
      inner: new MockProvider({ delayMs: 0, chunkSize: 80 }),
      config: DEFAULT_ROUTER_CONFIG,
    });
    setAppContext({
      store,
      provider: new SandboxTurnProvider({ inner: routed, delayMs: 0 }),
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
    const assistant = loaded?.messages.find((message) => message.role === "assistant");
    expect(assistant?.trace?.route).toMatchObject({
      tier: "cheap",
      reason: "chat",
      model: DEFAULT_ROUTER_CONFIG.cheap.id,
    });
    const events = await store.connection.query<{ type: string; input: string | null }>(
      `SELECT type, input FROM run_events ORDER BY run_id, seq`,
    );
    const parsed = events.rows.map((row) => ({
      type: row.type,
      input: row.input ? (JSON.parse(row.input) as Record<string, unknown>) : null,
    }));
    expect(parsed.find((row) => row.type === "model")?.input).toMatchObject({
      model: DEFAULT_ROUTER_CONFIG.cheap.id,
    });
    expect(parsed.find((row) => row.input?.name === "model.route")?.input).toMatchObject({
      tier: "cheap",
      reason: "chat",
      model: DEFAULT_ROUTER_CONFIG.cheap.id,
    });
  } finally {
    info.mockRestore();
  }
});

it("keeps the parent reply on its own tier when a delegate child uses another", async () => {
  const store = await ConversationStore.open();
  const routed = new RoutingProvider({
    inner: new MockProvider({
      delayMs: 0,
      chunkSize: 80,
      tools: (messages) => {
        const system = messages.find((message) => message.role === "system")?.content ?? "";
        if (system.includes("delegation: child")) return null;
        return [
          {
            id: "call_delegate",
            name: "delegate",
            arguments: JSON.stringify({
              agent: "Researcher",
              task: "Implement the parser in TypeScript",
            }),
          },
        ];
      },
      reply: (messages) => {
        const system = messages.find((message) => message.role === "system")?.content ?? "";
        if (system.includes("delegation: child")) return "Parser written.";
        return undefined;
      },
    }),
    config: DEFAULT_ROUTER_CONFIG,
  });
  setAppContext({
    store,
    provider: new SandboxTurnProvider({ inner: routed, delayMs: 0 }),
  });
  const created = await createAgent(
    new Request("http://localhost/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Researcher", instructions: "You write parsers." }),
    }),
  );
  expect(created.status).toBe(201);

  const response = await POST(
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Hello there" }),
    }),
  );
  const events = await readSse(response);
  expect(events.some((event) => event.event === "error")).toBe(false);

  const conversations = await store.listConversations();
  let parentRoute: { tier?: string; reason?: string } | undefined;
  for (const item of conversations) {
    const loaded = await store.getConversation(item.id);
    const asked = loaded?.messages.some(
      (message) => message.role === "user" && message.content === "Hello there",
    );
    if (!asked) continue;
    parentRoute = loaded?.messages.find((message) => message.role === "assistant")?.trace?.route;
  }
  expect(parentRoute).toMatchObject({
    tier: "cheap",
    reason: "chat",
    model: DEFAULT_ROUTER_CONFIG.cheap.id,
  });
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
  const streamed = provider.stream([{ role: "user", content: "Hello there" }]);
  expect(streamDecision(streamed)).toMatchObject({ tier: "cheap", model: "gpt-4o-mini" });
  for await (const _event of streamed) {
    // The fallback id has to be accepted by the constructor and sent as the model.
  }
  expect(
    () =>
      new RoutingProvider({
        inner: new MockProvider({ delayMs: 0, chunkSize: 80 }),
        config: {
          cheap: {
            id: "openai/gpt-4o",
            inputUsdPerMillion: 1,
            outputUsdPerMillion: 1,
            maxTokens: 128,
          },
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
  // Migration 011_run_events creates the run-replay table (run_id, seq, ...).
  // That shape has required columns this helper cannot fill, so it no-ops there;
  // chat records the route on that table through RunLog.recordModelRoute.
  clearRunEventSchemaCache();
  expect(
    await logModelRoute(
      {
        id: "route_migrated",
        kind: "model.route",
        tier: "cheap",
        reason: "chat",
        model: DEFAULT_ROUTER_CONFIG.cheap.id,
        costUsd: 0,
        inputTokens: 1,
        outputTokens: 1,
      },
      store.connection,
    ),
  ).toBe("noop");
  await store.connection.exec(`DROP TABLE run_events`);
  clearRunEventSchemaCache();
  clearRouteLogs();
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
    DROP TABLE run_events;
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
  const limits: number[] = [];
  const server = createServer(async (request, response) => {
    const body = JSON.parse(await readBody(request)) as { model?: string; max_tokens?: number };
    models.push(body.model ?? "");
    limits.push(body.max_tokens ?? 0);
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
    expect(limits).toEqual([
      DEFAULT_ROUTER_CONFIG.cheap.maxTokens,
      DEFAULT_ROUTER_CONFIG.strong.maxTokens,
    ]);
    expect(limits.every((limit) => limit < 65536)).toBe(true);
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
  const streamed = sandbox.stream([{ role: "user", content: "Hello there" }]);
  expect(streamDecision(streamed)).toMatchObject({ tier: "cheap", reason: "chat" });
  for await (const _event of streamed) {
    // Consume the mock reply.
  }
  expect(recentRouteLogs()[0]?.tier).toBe("cheap");
});

it("keeps concurrent requests on their own tiers", async () => {
  let entered = 0;
  let release = () => {};
  const bothEntered = new Promise<void>((resolve) => {
    release = resolve;
  });
  const gate: LlmProvider = {
    id: "mock",
    model: null,
    async *stream(messages, input) {
      entered += 1;
      if (entered >= 2) release();
      else await bothEntered;
      yield* new MockProvider({ delayMs: 0, chunkSize: 80 }).stream(messages, input);
    },
  };
  const store = await ConversationStore.open();
  const provider = new SandboxTurnProvider({
    inner: new RoutingProvider({ inner: gate, config: DEFAULT_ROUTER_CONFIG }),
    delayMs: 0,
  });
  const tools = createDefaultTools({});
  const approvals = new ApprovalGate();
  setAppContext({ store, provider, tools, approvals });
  const created = await createAgent(
    new Request("http://localhost/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Coder", instructions: "You write code." }),
    }),
  );
  expect(created.status).toBe(201);
  const coderId = ((await created.json()) as { agent: { id: string } }).agent.id;
  const [cheap, strong] = await Promise.all([
    streamChatTurn({
      store,
      provider,
      tools,
      approvals,
      message: "Hello there",
    }),
    streamChatTurn({
      store,
      provider,
      tools,
      approvals,
      message: "Implement the parser in TypeScript",
      agentId: coderId,
    }),
  ]);
  await Promise.all([readSse(cheap), readSse(strong)]);

  const routes = new Map<string, { tier?: string; reason?: string }>();
  for (const item of await store.listConversations()) {
    const loaded = await store.getConversation(item.id);
    const user = loaded?.messages.find((message) => message.role === "user");
    const assistant = loaded?.messages.find((message) => message.role === "assistant");
    if (user) routes.set(user.content, assistant?.trace?.route ?? {});
  }
  expect(routes.get("Hello there")).toMatchObject({
    tier: "cheap",
    reason: "chat",
    model: DEFAULT_ROUTER_CONFIG.cheap.id,
  });
  expect(routes.get("Implement the parser in TypeScript")).toMatchObject({
    tier: "strong",
    reason: "code",
    model: DEFAULT_ROUTER_CONFIG.strong.id,
  });
});

function liveStack(store: ConversationStore): LlmProvider {
  return new SandboxTurnProvider({
    inner: new RoutingProvider({
      inner: withAgentMock(
        selectProvider({
          LLM_PROVIDER: "mock",
          MOCK_STREAM_DELAY_MS: "0",
          MOCK_CHUNK_SIZE: "80",
        }),
      ),
      config: DEFAULT_ROUTER_CONFIG,
      db: store.connection,
    }),
    delayMs: 0,
  });
}

it("saves trace.route through the live chat route", async () => {
  const store = await ConversationStore.open();
  const provider = liveStack(store);
  expect(provider.constructor.name).toBe("SandboxTurnProvider");
  const carried = provider.stream([{ role: "user", content: "Hello there" }]);
  expect(streamDecision(carried)).toMatchObject({
    tier: "cheap",
    reason: "chat",
    model: DEFAULT_ROUTER_CONFIG.cheap.id,
  });
  for await (const _event of carried) {
    // The sandbox wrapper must expose the router decision, not drop it.
  }
  setAppContext({ store, provider });
  const response = await POST(
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Hello there" }),
    }),
  );
  const events = await readSse(response);
  expect(events.some((event) => event.event === "error")).toBe(false);
  expect(events.some((event) => event.event === "route")).toBe(false);
  const loaded = await store.getConversation((await store.listConversations())[0]!.id);
  expect(
    loaded?.messages.find((message) => message.role === "assistant")?.trace?.route,
  ).toMatchObject({
    tier: "cheap",
    reason: "chat",
    model: DEFAULT_ROUTER_CONFIG.cheap.id,
  });
});

it("saves trace.route when a yield* wrapper drops .decision", async () => {
  const store = await ConversationStore.open();
  const inner = liveStack(store);
  const dropping: LlmProvider = {
    id: inner.id,
    model: inner.model,
    async *stream(messages, input) {
      yield* inner.stream(messages, input);
    },
  };
  const dropped = dropping.stream([{ role: "user", content: "Hello there" }]);
  expect(streamDecision(dropped)).toBeUndefined();
  setAppContext({ store, provider: dropping });
  const response = await POST(
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Hello there" }),
    }),
  );
  await readSse(response);
  const loaded = await store.getConversation((await store.listConversations())[0]!.id);
  expect(
    loaded?.messages.find((message) => message.role === "assistant")?.trace?.route,
  ).toMatchObject({
    tier: "cheap",
    reason: "chat",
    model: DEFAULT_ROUTER_CONFIG.cheap.id,
  });
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
