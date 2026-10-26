import { createServer, type IncomingMessage } from "node:http";
import { once } from "node:events";
import { afterEach, expect, it } from "vitest";
import { POST as postChat } from "../app/api/chat/route";
import { GET as readRun } from "../app/api/runs/[id]/route";
import { resetAppContext, setAppContext } from "../src/context";
import { selectProvider } from "../src/llm";
import { redactSecrets } from "../src/runs/redact";
import { listRunEvents, runTotals } from "../src/runs/events";
import { ConversationStore } from "../src/store";
import { readSse } from "./helpers";

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
