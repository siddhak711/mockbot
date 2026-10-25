import { createServer, type IncomingMessage } from "node:http";
import { once } from "node:events";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { afterEach, expect, it } from "vitest";
import { POST } from "../app/api/chat/route";
import { GET as readStatus } from "../app/api/status/route";
import { resetAppContext, setAppContext } from "../src/context";
import { selectProvider } from "../src/llm";
import { ConversationStore } from "../src/store";
import { deltas, readSse } from "./helpers";

const SECRET = "super-secret-key-do-not-leak";

afterEach(async () => {
  await resetAppContext();
});

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

it("selects the mock provider unless openai and an API key are both set", () => {
  expect(selectProvider({}).id).toBe("mock");
  expect(selectProvider({ LLM_PROVIDER: "mock", LLM_API_KEY: SECRET }).id).toBe("mock");
  expect(() => selectProvider({ LLM_PROVIDER: "openai" })).toThrow(/LLM_API_KEY/);
  const provider = selectProvider({
    LLM_PROVIDER: "openai",
    LLM_API_KEY: SECRET,
    LLM_BASE_URL: "https://openrouter.ai/api/v1",
    LLM_MODEL: "deepseek/deepseek-v4.1-flash",
  });
  expect(provider.id).toBe("openai");
  expect(provider.model).toBe("deepseek/deepseek-v4.1-flash");
});

it("sends the turn to the configured base URL and keeps the key off the client response", async () => {
  const seen: { authorization?: string; url?: string; body?: string } = {};
  const server = createServer(async (request, response) => {
    seen.authorization = request.headers.authorization;
    seen.url = request.url;
    seen.body = await readBody(request);
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write('data: {"choices":[{"delta":{"content":"Upstream "}}]}\n\n');
    response.write('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n');
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
        LLM_API_KEY: SECRET,
        LLM_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
        LLM_MODEL: "deepseek/deepseek-v4.1-flash",
      }),
    });

    const response = await POST(
      new Request("http://localhost/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "Talk to upstream" }),
      }),
    );
    const events = await readSse(response);
    const raw = JSON.stringify(events);

    expect(seen.authorization).toBe(`Bearer ${SECRET}`);
    expect(seen.url).toBe("/v1/chat/completions");
    const forwarded = JSON.parse(seen.body ?? "{}") as {
      model?: string;
      messages?: Array<{ content: string }>;
    };
    expect(forwarded.model).toBe("deepseek/deepseek-v4.1-flash");
    expect(forwarded.messages?.some((message) => message.content === "Talk to upstream")).toBe(
      true,
    );
    expect(deltas(events)).toBe("Upstream hello");
    expect(events.some((event) => event.event === "end")).toBe(true);
    const end = events.find((event) => event.event === "end");
    expect((end?.data as { finishReason?: string }).finishReason).toBe("stop");
    expect(raw).not.toContain(SECRET);
    expect(raw).not.toContain("LLM_API_KEY");

    const loaded = await store.getConversation((await store.listConversations())[0]!.id);
    expect(JSON.stringify(loaded)).not.toContain(SECRET);

    const status = await readStatus();
    const statusText = await status.text();
    expect(statusText).toContain("openai");
    expect(statusText).toContain("deepseek/deepseek-v4.1-flash");
    expect(statusText).not.toContain(SECRET);
  } finally {
    server.close();
  }
});

it("redacts an upstream error that echoes the API key", async () => {
  const server = createServer(async (request, response) => {
    await readBody(request);
    response.writeHead(401, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: `rejected ${SECRET}` }));
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
        LLM_API_KEY: SECRET,
        LLM_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
        LLM_MODEL: "deepseek/deepseek-v4.1-flash",
      }),
    });
    const response = await POST(
      new Request("http://localhost/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "This should fail" }),
      }),
    );
    const events = await readSse(response);
    const raw = JSON.stringify(events);
    expect(events.some((event) => event.event === "error")).toBe(true);
    expect(raw).toContain("[redacted]");
    expect(raw).not.toContain(SECRET);
    const loaded = await store.getConversation((await store.listConversations())[0]!.id);
    expect(loaded?.messages.map((message) => message.role)).toEqual(["user"]);
  } finally {
    server.close();
  }
});

it("does not reference provider secrets from browser code", () => {
  const files = [
    ...walk("components"),
    ...walk("app").filter((file) => !file.includes(`${sep}api${sep}`)),
  ];
  expect(files.length).toBeGreaterThan(0);
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    expect(source, file).not.toContain("LLM_API_KEY");
    expect(source, file).not.toContain("LLM_BASE_URL");
    expect(source, file).not.toContain("Authorization");
  }
});

function walk(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const info = statSync(path);
    if (info.isDirectory()) found.push(...walk(path));
    else if (/\.(tsx?|css)$/.test(entry)) found.push(path);
  }
  return found;
}
