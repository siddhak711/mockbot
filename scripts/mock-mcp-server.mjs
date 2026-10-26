import { createServer } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createMcpHandler, fromJsonSchema, McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";

const echoSchema = {
  type: "object",
  properties: {
    message: { type: "string", description: "Text to echo" },
  },
  required: ["message"],
  additionalProperties: false,
};

const probeSchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

function text(value) {
  return { content: [{ type: "text", text: value }] };
}

export function createMockServer(leak, extraTools = []) {
  const server = new McpServer({ name: "mock-mcp", version: "1.0.0" });
  const description = leak
    ? `Echo a message. Marker ${leak}`
    : "Echo a message. Returns the same message, unchanged.";
  server.registerTool(
    "echo",
    {
      description,
      inputSchema: fromJsonSchema(echoSchema),
    },
    async (args) => {
      const message = args && typeof args.message === "string" ? args.message : "";
      const payload = { message, source: "mock-mcp" };
      if (leak) payload.marker = leak;
      return text(JSON.stringify(payload));
    },
  );
  server.registerTool(
    "env_probe",
    {
      description: "Report whether selected environment variables are set, without their values.",
      inputSchema: fromJsonSchema(probeSchema),
    },
    async () =>
      text(
        JSON.stringify({
          llm: process.env.LLM_API_KEY ? "present" : "absent",
          demo: process.env.MCP_DEMO_TOKEN ? "present" : "absent",
        }),
      ),
  );
  for (const name of extraTools) {
    server.registerTool(
      name,
      { description: name, inputSchema: fromJsonSchema(probeSchema) },
      async () => text("ok"),
    );
  }
  return server;
}

function headerEntries(headers) {
  const out = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (value == null) continue;
    if (
      key === "host" ||
      key === "connection" ||
      key === "content-length" ||
      key === "transfer-encoding"
    ) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) out.append(key, item);
    } else {
      out.set(key, value);
    }
  }
  return out;
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/**
 * @param {{
 *   port?: number,
 *   leak?: string | null,
 *   gate?: () => Promise<void>,
 *   auth?: "none" | "apikey" | "oauth",
 *   token?: string,
 *   extraTools?: string[],
 * }} [options]
 */
export async function startMockMcpServer(options = {}) {
  const leak = options.leak ?? null;
  const gate = options.gate;
  const auth = options.auth ?? "none";
  const token = options.token ?? "test-key";
  const extraTools = options.extraTools ?? [];
  const authorizations = [];
  const activity = { inflight: 0, handled: 0 };
  const handler = createMcpHandler(() => createMockServer(leak, extraTools));
  const httpServer = createServer(async (req, res) => {
    activity.inflight += 1;
    try {
      if (gate) await gate();
      await handleHttp(req, res, handler, authorizations, auth, token);
      activity.handled += 1;
    } catch {
      if (!res.headersSent) res.statusCode = 500;
      res.end();
    } finally {
      activity.inflight -= 1;
    }
  });
  const port = options.port ?? 0;
  await new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, "127.0.0.1", () => resolve());
  });
  const address = httpServer.address();
  if (!address || typeof address === "string") throw new Error("Mock MCP server failed to listen");
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    authorizations,
    activity,
    async close() {
      await handler.close().catch(() => undefined);
      await new Promise((resolve, reject) => {
        httpServer.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

async function handleHttp(req, res, handler, authorizations, auth = "none", token = "test-key") {
  const host = req.headers.host ?? "127.0.0.1";
  const url = new URL(req.url ?? "/", `http://${host}`);
  if (url.pathname !== "/mcp") {
    res.statusCode = 404;
    res.end("Not found");
    return;
  }
  const authorization = req.headers.authorization;
  if (typeof authorization === "string" && authorization) authorizations.push(authorization);
  if (auth === "oauth") {
    res.statusCode = 401;
    res.setHeader(
      "www-authenticate",
      'Bearer realm="oauth", resource_metadata="https://example.com/.well-known/oauth-protected-resource"',
    );
    res.end("unauthorized");
    return;
  }
  if (auth === "apikey" && authorization !== `Bearer ${token}`) {
    res.statusCode = 401;
    res.setHeader("www-authenticate", "Bearer");
    res.end("unauthorized");
    return;
  }
  const body = await readBody(req);
  const method = req.method ?? "GET";
  const request = new Request(url, {
    method,
    headers: headerEntries(req.headers),
    body: method === "GET" || method === "HEAD" || body.length === 0 ? undefined : body,
  });
  const response = await handler.fetch(request);
  res.statusCode = response.status;
  response.headers.forEach((value, key) => {
    if (key === "transfer-encoding" || key === "content-encoding" || key === "content-length")
      return;
    res.setHeader(key, value);
  });
  const payload = Buffer.from(await response.arrayBuffer());
  res.setHeader("content-length", String(payload.length));
  res.end(payload);
}

function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) return false;
  return resolve(entry) === fileURLToPath(import.meta.url);
}

if (isDirectRun()) {
  const httpFlag = process.argv.indexOf("--http");
  const leak = process.env.MOCK_MCP_LEAK || null;
  if (httpFlag !== -1) {
    const port = Number(process.argv[httpFlag + 1] ?? 8787);
    const server = await startMockMcpServer({ port: Number.isFinite(port) ? port : 8787, leak });
    console.error(`mock mcp listening ${server.url}`);
  } else {
    serveStdio(() => createMockServer(leak));
    console.error("mock mcp listening on stdio");
  }
}
