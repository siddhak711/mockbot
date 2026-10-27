import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { PATCH as patchConnector } from "../app/api/connectors/[id]/route";
import { PATCH as patchTools } from "../app/api/connectors/[id]/tools/route";
import { POST as detectConnector } from "../app/api/connectors/detect/route";
import { GET as getConnectors, POST as createConnector } from "../app/api/connectors/route";
import { connectorForActivity, serverProvidedError } from "../components/connectors-panel";
import { searchCatalog } from "../src/connectors/catalog";
import { probeConnector } from "../src/connectors/probe";
import { ReconnectAttempt } from "../src/connectors/reconnect";
import { joinCommand, type ConnectorRecord, type ConnectorToolSetting } from "../src/connectors";
import {
  applyBulk,
  classifyToolRisk,
  defaultToolSetting,
  detectInput,
  discoverTool,
  PASTED_OAUTH_UNSUPPORTED_MESSAGE,
  resolveToolSettings,
} from "../src/connectors/policy";
import { noteConnectorOutcome } from "../src/connectors/runtime";
import { resetAppContext, setAppContext } from "../src/context";
import { MockProvider } from "../src/llm";
import { refreshMcpTools } from "../src/mcp/sync";
import { decryptSecret, encryptSecret } from "../src/mcp/vault";
import { ConversationStore } from "../src/store";
import { requiresApproval } from "../src/tools/approval";
import { createDefaultTools } from "../src/tools/builtins";
import { ToolRegistry } from "../src/tools/registry";
import { startMockMcpServer } from "../scripts/mock-mcp-server.mjs";

afterEach(async () => {
  await resetAppContext();
});

it("classifies pasted input, catalog search, and tool risk", () => {
  expect(detectInput("notion").kind).toBe("search");
  const invalidUrl = detectInput("https://");
  expect(invalidUrl.kind).toBe("url");
  if (invalidUrl.kind === "url") expect(invalidUrl.valid).toBe(false);
  expect(detectInput("https://mcp.acme.dev/mcp")).toMatchObject({
    kind: "url",
    valid: true,
    target: "https://mcp.acme.dev/mcp",
  });
  expect(detectInput("npx @acme/mcp")).toMatchObject({ kind: "command", valid: true });
  expect(detectInput("npx").kind).toBe("search");
  expect(detectInput("{")).toMatchObject({ kind: "config", valid: false });
  const config = detectInput(
    JSON.stringify({ mcpServers: { demo: { command: "npx", args: ["@acme/mcp"] } } }),
  );
  expect(config).toMatchObject({
    kind: "config",
    valid: true,
    name: "demo",
    transport: "stdio",
    target: "npx @acme/mcp",
  });

  expect(searchCatalog("notion").map((entry) => entry.id)).toContain("notion");
  expect(searchCatalog("acme crm")).toEqual([]);

  expect(classifyToolRisk("search_pages")).toBe("read");
  expect(classifyToolRisk("delete_page")).toBe("destructive");
  expect(classifyToolRisk("export_pdf")).toBe("write");
  expect(classifyToolRisk("mystery", {})).toBe("write");
  expect(classifyToolRisk("delete_page", { readOnlyHint: true })).toBe("read");
  expect(classifyToolRisk("search_pages", { destructiveHint: true })).toBe("destructive");
  expect(defaultToolSetting("read")).toEqual({ enabled: true, approval: "auto" });
  expect(defaultToolSetting("write")).toEqual({ enabled: false, approval: "ask" });
  expect(defaultToolSetting("destructive")).toEqual({ enabled: false, approval: "ask" });

  const discovered = [
    discoverTool("search_pages", "Search", { type: "object" }, { readOnlyHint: true }),
    discoverTool("create_page", "Create", { type: "object" }),
    discoverTool("delete_page", "Delete", { type: "object" }, { destructiveHint: true }),
    discoverTool("export_pdf", "Export", { type: "string" }),
  ];
  const settings = resolveToolSettings(
    discovered,
    {
      delete_page: { enabled: true, approval: "auto" },
      create_page: { enabled: true, approval: "auto" },
    },
    "defaults",
  );
  expect(settings.search_pages).toMatchObject({ enabled: true, approval: "auto", risk: "read" });
  expect(settings.create_page).toMatchObject({ enabled: true, approval: "auto", risk: "write" });
  expect(settings.delete_page).toMatchObject({
    enabled: true,
    approval: "ask",
    risk: "destructive",
  });
  expect(settings.export_pdf).toMatchObject({ enabled: false, skipped: true });

  const bulk = applyBulk(
    [
      {
        name: "search_pages",
        description: "",
        risk: "read",
        enabled: false,
        approval: "auto",
        skipped: false,
      },
      {
        name: "create_page",
        description: "",
        risk: "write",
        enabled: false,
        approval: "ask",
        skipped: false,
      },
      {
        name: "export_pdf",
        description: "",
        risk: "write",
        enabled: false,
        approval: "ask",
        skipped: true,
      },
    ],
    "read-on",
  );
  expect(bulk.find((tool) => tool.name === "search_pages")?.enabled).toBe(true);
  expect(bulk.find((tool) => tool.name === "create_page")?.enabled).toBe(false);
  expect(bulk.find((tool) => tool.name === "export_pdf")?.skipped).toBe(true);
  const allOn = applyBulk(bulk, "all-on");
  expect(allOn.find((tool) => tool.name === "create_page")?.enabled).toBe(true);
  expect(allOn.find((tool) => tool.name === "export_pdf")?.enabled).toBe(false);
});

it("keeps text colors at AA 4.5:1 and keeps faint, accent, and line-strong off text", () => {
  const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
  const tokens = JSON.parse(
    readFileSync(new URL("../docs/design/tokens.json", import.meta.url), "utf8"),
  ) as { color: { light: Record<string, string>; dark: Record<string, string> } };
  const light = variables(css, ":root {");
  const dark = variables(css, ':root[data-theme="dark"]');
  const systemDark = variables(css, ':root:not([data-theme="light"])');
  const backgrounds = ["window", "sidebar", "surface", "selected", "hover"] as const;
  const text = [
    "ink",
    "ink-2",
    "muted",
    "link",
    "accent-text",
    "success",
    "danger",
    "warn",
  ] as const;

  for (const [name, cssVars, tokenTheme] of [
    ["light", light, tokens.color.light],
    ["dark", dark, tokens.color.dark],
  ] as const) {
    for (const [token, value] of Object.entries(tokenTheme)) {
      expect(normColor(cssVars[token] ?? ""), `${name} ${token}`).toBe(normColor(value));
    }
    expect(normColor(cssVars["danger-fill"] ?? ""), `${name} danger-fill`).toBe(
      normColor(tokenTheme.danger ?? ""),
    );
  }
  for (const token of [...Object.keys(tokens.color.dark), "danger-fill", "on-danger"]) {
    expect(normColor(systemDark[token] ?? ""), token).toBe(normColor(dark[token] ?? ""));
  }

  for (const theme of [light, dark]) {
    for (const foreground of text) {
      for (const backgroundName of backgrounds) {
        const background = parseColor(theme[backgroundName] ?? "");
        expect(
          contrast(paint(theme[foreground] ?? "", background), background),
          `${foreground} on ${backgroundName}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
    const dangerFill = parseColor(theme["danger-fill"] ?? "");
    const ink = parseColor(theme.ink ?? "");
    expect(
      contrast(paint(theme["on-danger"] ?? "", dangerFill), dangerFill),
      "on-danger on danger",
    ).toBeGreaterThanOrEqual(4.5);
    expect(contrast(parseColor(theme.window ?? ""), ink), "window on ink").toBeGreaterThanOrEqual(
      4.5,
    );
    expect(
      contrast(parseColor(theme["accent-on-ink"] ?? ""), ink),
      "accent-on-ink on ink",
    ).toBeGreaterThanOrEqual(4.5);
  }

  const selected = parseColor(light.selected ?? "");
  expect(
    contrast(paint(light.link ?? "", selected), selected),
    "link on selected",
  ).toBeGreaterThanOrEqual(4.6);

  const textUses: string[] = [];
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = (match[1] ?? "").replace(/\s+/g, " ").trim();
    const body = match[2] ?? "";
    for (const color of body.matchAll(/(?:^|;)\s*color:\s*var\(--(faint|accent|line-strong)\)/gm)) {
      textUses.push(`${selector} -> ${color[1]}`);
    }
  }
  expect(textUses).toEqual([".tool-mark -> faint", ".try-chip svg -> accent"]);
});

it("keeps landing text tokens at AA 4.5:1 on page, band, and card surfaces", () => {
  const css = readFileSync(new URL("../components/landing/landing.css", import.meta.url), "utf8");
  const theme = variables(css, ".daylight {");
  const surfaces = {
    page: theme.bg ?? "",
    band: theme.bg2 ?? "",
    card: "#ffffff",
  };
  for (const token of ["ink", "t2", "t3"] as const) {
    for (const [name, value] of Object.entries(surfaces)) {
      const background = parseColor(value);
      expect(
        contrast(paint(theme[token] ?? "", background), background),
        `${token} on ${name}`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  }

  for (const selector of [
    ".daylight .msg",
    ".daylight .dayhead",
    ".daylight .ev .t",
    ".daylight .ev p",
    ".daylight form.wl input::placeholder",
  ]) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const block = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
    expect(block?.[1] ?? "", selector).toMatch(/color:\s*var\(--t[23]\)/);
  }
});

it("detects search, invalid input, oauth, api keys, and unreachable servers", async () => {
  const search = await detectConnector(jsonRequest({ input: "notion" }));
  const searchBody = (await search.json()) as { matches: Array<{ id: string }> };
  expect(search.status).toBe(200);
  expect(searchBody.matches.some((match) => match.id === "notion")).toBe(true);

  const invalid = await detectConnector(jsonRequest({ input: "https://" }));
  expect(invalid.status).toBe(400);
  expect(await invalid.text()).toContain("valid URL");

  const down = await detectConnector(jsonRequest({ input: "http://127.0.0.1:1/mcp" }));
  expect(down.status).toBe(400);
  expect(await down.text()).toContain("Couldn't reach");

  const oauth = await startMockMcpServer({ auth: "oauth" });
  const keyed = await startMockMcpServer({ auth: "apikey", token: "connector-key" });
  try {
    const oauthResponse = await detectConnector(jsonRequest({ input: oauth.url }));
    expect(oauthResponse.status).toBe(200);
    expect(await oauthResponse.json()).toMatchObject({ auth: "oauth", tools: [] });

    const missing = await detectConnector(jsonRequest({ input: keyed.url }));
    expect(missing.status).toBe(200);
    expect(await missing.json()).toMatchObject({ auth: "apikey" });

    const rejected = await detectConnector(jsonRequest({ input: keyed.url, apiKey: "wrong-key" }));
    expect(rejected.status).toBe(400);
    expect(await rejected.text()).toContain("That key was rejected.");

    const accepted = await detectConnector(
      jsonRequest({ input: keyed.url, apiKey: "connector-key" }),
    );
    const acceptedBody = (await accepted.json()) as {
      auth: string;
      tools: Array<{ name: string; risk: string }>;
    };
    expect(accepted.status).toBe(200);
    expect(acceptedBody.auth).toBe("apikey");
    expect(acceptedBody.tools.map((tool) => tool.name).sort()).toEqual(["echo", "env_probe"]);
    expect(acceptedBody.tools.every((tool) => tool.risk === "write")).toBe(true);
    expect(JSON.stringify(acceptedBody)).not.toContain("connector-key");
  } finally {
    await oauth.close();
    await keyed.close();
  }
});

it("saves catalog defaults and keeps the api key off the client", async () => {
  const store = await ConversationStore.open();
  setAppContext({
    store,
    provider: new MockProvider({ delayMs: 0 }),
    tools: createDefaultTools(process.env),
  });
  const server = await startMockMcpServer({ auth: "apikey", token: "connector-key" });
  try {
    const keyed = await createConnector(
      jsonRequest({
        name: "Acme",
        transport: "http",
        target: server.url,
        apiKey: "connector-key",
        tools: {
          echo: { enabled: true, approval: "ask" },
          env_probe: { enabled: false, approval: "ask" },
        },
      }),
    );
    const keyedText = await keyed.text();
    expect(keyed.status, keyedText).toBe(201);
    expect(keyedText).not.toContain("connector-key");
    expect(keyedText).not.toContain("secretCipher");
    const listed = await (await getConnectors()).text();
    expect(listed).not.toContain("connector-key");
    expect(listed).not.toContain("secretCipher");

    const registry = new ToolRegistry();
    await refreshMcpTools({
      registry,
      connectors: await store.listConnectors(),
      env: process.env,
    });
    const echo = registry.get("acme_echo");
    expect(echo?.approval).toBe("always");
    expect(echo?.skipHeuristicApproval).toBe(false);
    expect(echo ? requiresApproval(echo, { message: "ping" }) : false).toBe(true);
    expect(registry.get("acme_env_probe")).toBeUndefined();

    const id = JSON.parse(keyedText).connector.id as string;
    await store.updateConnectorTools(id, {
      echo: {
        enabled: true,
        approval: "ask",
        risk: "write",
        description: "Echo a message",
        skipped: false,
      },
    });
    let appeared: { enabled: boolean; approval: string; risk?: string } | undefined;
    await refreshMcpTools({
      registry: new ToolRegistry(),
      connectors: await store.listConnectors(),
      env: process.env,
      onTools: (_connectorId, tools) => {
        appeared = tools.env_probe;
      },
    });
    expect(appeared).toMatchObject({ enabled: false, approval: "ask", risk: "write" });
    const disabled = await patchTools(
      jsonRequest({ tools: { echo: { enabled: false, approval: "ask" } } }),
      {
        params: Promise.resolve({ id }),
      },
    );
    expect(disabled.status).toBe(200);
    const next = new ToolRegistry();
    await refreshMcpTools({
      registry: next,
      connectors: await store.listConnectors(),
      env: process.env,
    });
    expect(next.get("acme_echo")).toBeUndefined();

    const forced = await patchTools(
      jsonRequest({ tools: { delete_page: { enabled: true, approval: "auto" } } }),
      { params: Promise.resolve({ id }) },
    );
    const forcedBody = (await forced.json()) as {
      connector: { tools: Record<string, { approval: string }> };
    };
    expect(forcedBody.connector.tools.delete_page.approval).toBe("ask");

    await noteConnectorOutcome(store, id, { isError: true, content: "401 unauthorized" });
    expect((await store.listConnectors()).find((item) => item.id === id)?.status).toBe("reconnect");
    const paused = new ToolRegistry();
    await refreshMcpTools({
      registry: paused,
      connectors: await store.listConnectors(),
      env: process.env,
    });
    expect(paused.get("acme_echo")).toBeUndefined();

    const reconnected = await patchConnector(
      jsonRequest({ reconnected: true, apiKey: "connector-key" }),
      { params: Promise.resolve({ id }) },
    );
    const reconnectedText = await reconnected.text();
    expect(reconnected.status, reconnectedText).toBe(200);
    expect(reconnectedText).not.toContain("connector-key");
    const again = (await store.listConnectors()).find((item) => item.id === id);
    expect(again?.status).toBe("connected");
    expect(await decryptSecret(again?.secretCipher ?? "")).toBe("connector-key");
  } finally {
    await server.close();
  }
});

it("asks before a legacy connector runs a send tool", async () => {
  const server = await startMockMcpServer({ extraTools: ["send_note", "search_pages"] });
  try {
    const store = await ConversationStore.open();
    setAppContext({
      store,
      provider: new MockProvider({ delayMs: 0 }),
      tools: createDefaultTools(process.env),
    });
    await store.createConnector({
      name: "Demo",
      transport: "http",
      target: server.url,
      secretRef: null,
      tools: {},
    });
    const registry = new ToolRegistry();
    await refreshMcpTools({
      registry,
      connectors: await store.listConnectors(),
      env: process.env,
    });
    const send = registry.get("demo_send_note");
    expect(send?.skipHeuristicApproval).toBe(false);
    expect(send ? requiresApproval(send, {}) : false).toBe(true);
    const search = registry.get("demo_search_pages");
    expect(search?.skipHeuristicApproval).toBe(true);
    expect(search ? requiresApproval(search, {}) : true).toBe(false);
  } finally {
    await server.close();
  }
});

it("reads CONNECTOR_SECRET_KEY and refuses to mint one in production", async () => {
  const env = process.env as Record<string, string | undefined>;
  const previousNode = env.NODE_ENV;
  const previousKey = env.CONNECTOR_SECRET_KEY;
  const previousVercel = env.VERCEL;
  delete env.CONNECTOR_SECRET_KEY;
  delete env.VERCEL;
  env.NODE_ENV = "production";
  try {
    await expect(encryptSecret("connector-secret")).rejects.toThrow(/CONNECTOR_SECRET_KEY/);
    env.CONNECTOR_SECRET_KEY = Buffer.alloc(32, 4).toString("base64");
    const cipher = await encryptSecret("connector-secret");
    expect(cipher).not.toContain("connector-secret");
    expect(await decryptSecret(cipher)).toBe("connector-secret");
  } finally {
    env.NODE_ENV = previousNode;
    if (previousKey == null) delete env.CONNECTOR_SECRET_KEY;
    else env.CONNECTOR_SECRET_KEY = previousKey;
    if (previousVercel == null) delete env.VERCEL;
    else env.VERCEL = previousVercel;
  }
});

it("clears a reconnect attempt on cancel, back, and success", () => {
  const attempt = new ReconnectAttempt();
  attempt.start("connector-old");
  attempt.clear();
  expect(attempt.id).toBeNull();

  attempt.start("connector-old");
  expect(attempt.take()).toBe("connector-old");
  expect(attempt.id).toBeNull();

  attempt.start("connector-old");
  attempt.clear();
  expect(attempt.take()).toBeNull();
});

it("matches the longest connector slug and an exact connector id", () => {
  const notion = sampleConnector("11111111-1111-1111-1111-111111111111", "Notion");
  const calendar = sampleConnector("22222222-2222-2222-2222-222222222222", "Notion Calendar");
  const connectors = [notion, calendar];
  expect(connectorForActivity(connectors, "notion_calendar_list_events")?.id).toBe(calendar.id);
  expect(connectorForActivity(connectors, "notion_search_pages")?.id).toBe(notion.id);
  expect(connectorForActivity(connectors, "notion_search_22222222")?.id).toBe(calendar.id);
});

it("skips the name heuristic when a write tool is set to always allow", async () => {
  const server = await startMockMcpServer({ extraTools: ["send_note", "send_mail"] });
  try {
    const store = await ConversationStore.open();
    setAppContext({
      store,
      provider: new MockProvider({ delayMs: 0 }),
      tools: createDefaultTools(process.env),
    });
    const setting = (approval: "ask" | "auto"): ConnectorToolSetting => ({
      enabled: true,
      approval,
      risk: "write",
      description: "send",
      skipped: false,
    });
    await store.createConnector({
      name: "Demo",
      transport: "http",
      target: server.url,
      secretRef: null,
      tools: { send_note: setting("auto"), send_mail: setting("ask") },
    });
    const registry = new ToolRegistry();
    await refreshMcpTools({
      registry,
      connectors: await store.listConnectors(),
      env: process.env,
    });
    const allowed = registry.get("demo_send_note");
    const asked = registry.get("demo_send_mail");
    expect(allowed?.skipHeuristicApproval).toBe(true);
    expect(allowed ? requiresApproval(allowed, {}) : true).toBe(false);
    expect(asked?.skipHeuristicApproval).toBe(false);
    expect(asked ? requiresApproval(asked, {}) : false).toBe(true);
  } finally {
    await server.close();
  }
});

it("keeps stored tools that are missing from the current listing", async () => {
  const extras = Array.from({ length: 33 }, (_, index) => `tool_${String(index).padStart(2, "0")}`);
  const server = await startMockMcpServer({ extraTools: extras });
  try {
    const store = await ConversationStore.open();
    setAppContext({
      store,
      provider: new MockProvider({ delayMs: 0 }),
      tools: createDefaultTools(process.env),
    });
    const tools: Record<string, ConnectorToolSetting> = {
      echo: {
        enabled: true,
        approval: "ask",
        risk: "write",
        description: "stale echo description",
        skipped: false,
      },
      kept_offline: {
        enabled: false,
        approval: "ask",
        risk: "write",
        description: "stored but not listed",
        skipped: false,
      },
    };
    for (const name of extras) {
      tools[name] = {
        enabled: false,
        approval: "ask",
        risk: "write",
        description: name,
        skipped: false,
      };
    }
    await store.createConnector({
      name: "Demo",
      transport: "http",
      target: server.url,
      secretRef: null,
      tools,
    });
    let written: Record<string, ConnectorToolSetting> | undefined;
    await refreshMcpTools({
      registry: new ToolRegistry(),
      connectors: await store.listConnectors(),
      env: process.env,
      onTools: (_id, next) => {
        written = next;
      },
    });
    expect(written?.kept_offline?.description).toBe("stored but not listed");
    expect(written?.tool_32?.description).toBe("tool_32");
    expect(Object.keys(written ?? {})).toEqual(expect.arrayContaining(["kept_offline", ...extras]));
    expect(written?.echo?.description).not.toBe("stale echo description");
  } finally {
    await server.close();
  }
});

it("still probes a server when the transport peek fails", async () => {
  const server = await startMockMcpServer();
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = (
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    if (method === "GET" && !headers.get("accept")?.includes("text/event-stream")) {
      throw new Error("peek failed");
    }
    return original(input, init);
  }) as typeof fetch;
  try {
    const result = await probeConnector({ transport: "http", target: server.url });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.tools.some((tool) => tool.name === "echo")).toBe(true);
  } finally {
    globalThis.fetch = original;
    await server.close();
  }
});

it("passes a saved stdio api key to the child as MCP_PROBE_KEY", async () => {
  const store = await ConversationStore.open();
  setAppContext({
    store,
    provider: new MockProvider({ delayMs: 0 }),
    tools: createDefaultTools(process.env),
  });
  const script = join(process.cwd(), "scripts/mock-mcp-server.mjs");
  const created = await createConnector(
    jsonRequest({
      name: "Local",
      transport: "stdio",
      target: joinCommand([process.execPath, script]),
      apiKey: "stdio-secret",
      tools: { env_probe: { enabled: true, approval: "auto" } },
    }),
  );
  const createdText = await created.text();
  expect(created.status, createdText).toBe(201);
  expect(createdText).not.toContain("stdio-secret");
  const registry = new ToolRegistry();
  await refreshMcpTools({
    registry,
    connectors: await store.listConnectors(),
    env: process.env,
  });
  const tool = registry.get("local_env_probe");
  expect(tool?.skipHeuristicApproval).toBe(true);
  const result = await tool?.invoke({}, {});
  expect(result?.content).toContain('"probe":"present"');
  expect(result?.content).not.toContain("stdio-secret");
});

it("refuses pasted oauth connectors instead of saving a made-up token", async () => {
  const server = await startMockMcpServer({ auth: "oauth" });
  try {
    const store = await ConversationStore.open();
    setAppContext({
      store,
      provider: new MockProvider({ delayMs: 0 }),
      tools: createDefaultTools(process.env),
    });
    for (const body of [
      { name: "Acme", transport: "http", target: server.url, oauth: true },
      { name: "Acme", transport: "http", target: server.url },
    ]) {
      const created = await createConnector(jsonRequest(body));
      expect(created.status).toBe(400);
      expect(((await created.json()) as { error: string }).error).toBe(
        PASTED_OAUTH_UNSUPPORTED_MESSAGE,
      );
    }
    expect(await store.listConnectors()).toEqual([]);
  } finally {
    await server.close();
  }
});

function sampleConnector(id: string, name: string): ConnectorRecord {
  return {
    id,
    name,
    transport: "http",
    target: "https://example.com/mcp",
    secretRef: null,
    enabled: true,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
}

it("returns a JSON error when connector creation cannot encrypt a secret", async () => {
  const previousKey = process.env.CONNECTOR_SECRET_KEY;
  const previousDemo = process.env.MCP_DEMO_TOKEN;
  process.env.CONNECTOR_SECRET_KEY = "not-a-valid-key";
  process.env.MCP_DEMO_TOKEN = "demo-token";
  const store = await ConversationStore.open();
  setAppContext({
    store,
    provider: new MockProvider({ delayMs: 0 }),
    tools: createDefaultTools(process.env),
  });
  const oauth = await startMockMcpServer({ auth: "oauth" });
  const keyed = await startMockMcpServer({ auth: "apikey", token: "connector-key" });
  const open = await startMockMcpServer();
  try {
    const unknown = await createConnector(jsonRequest({ catalogId: "nope" }));
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toEqual({ error: "Unknown connector." });

    const catalog = await createConnector(
      jsonRequest({ catalogId: "notion", accountLabel: "workspace" }),
    );
    expect(catalog.headers.get("content-type")).toContain("application/json");
    const catalogBody = (await catalog.json()) as { error?: string };
    expect(catalog.status).toBe(400);
    expect(catalogBody.error).toMatch(/OAuth/);
    expect(catalogBody.error).not.toMatch(/CONNECTOR_SECRET_KEY/);
    expect(serverProvidedError(catalogBody)).toBe(catalogBody.error);

    const pastedOauth = await createConnector(
      jsonRequest({ name: "Acme", transport: "http", target: oauth.url, oauth: true }),
    );
    const oauthBody = (await pastedOauth.json()) as { error?: string };
    expect(pastedOauth.status).toBe(400);
    expect(oauthBody.error).toBe(PASTED_OAUTH_UNSUPPORTED_MESSAGE);

    const pastedKey = await createConnector(
      jsonRequest({
        name: "Acme",
        transport: "http",
        target: keyed.url,
        apiKey: "connector-key",
        tools: { echo: { enabled: true, approval: "ask" } },
      }),
    );
    const keyBody = (await pastedKey.json()) as { error?: string };
    expect(pastedKey.status).toBe(500);
    expect(keyBody.error).toMatch(/CONNECTOR_SECRET_KEY/);

    store.createConnector = async () => {
      throw new Error("connector store failed");
    };
    const secretRef = await createConnector(
      jsonRequest({
        name: "Acme",
        transport: "http",
        target: open.url,
        secretRef: "MCP_DEMO_TOKEN",
      }),
    );
    const secretBody = (await secretRef.json()) as { error?: string };
    expect(secretRef.status).toBe(500);
    expect(secretBody.error).toBe("connector store failed");
    expect(serverProvidedError(secretBody)).toBe("connector store failed");
    expect(serverProvidedError(null)).toBeNull();
    expect(serverProvidedError({ message: "from message" })).toBe("from message");
  } finally {
    await oauth.close();
    await keyed.close();
    await open.close();
    if (previousKey == null) delete process.env.CONNECTOR_SECRET_KEY;
    else process.env.CONNECTOR_SECRET_KEY = previousKey;
    if (previousDemo == null) delete process.env.MCP_DEMO_TOKEN;
    else process.env.MCP_DEMO_TOKEN = previousDemo;
  }
});

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/api/connectors", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

type RGB = { r: number; g: number; b: number };

function normColor(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, "").replace(/0\./g, ".");
}

function variables(css: string, header: string): Record<string, string> {
  const start = css.indexOf(header);
  if (start < 0) throw new Error(`Missing ${header}`);
  const open = css.indexOf("{", start);
  const close = css.indexOf("}", open);
  const vars: Record<string, string> = {};
  for (const match of css.slice(open + 1, close).matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) {
    vars[match[1] ?? ""] = match[2]?.trim() ?? "";
  }
  return vars;
}

function paint(value: string, background: RGB): RGB {
  return parseColor(value, background);
}

function parseColor(value: string, background?: RGB): RGB {
  const text = value.trim();
  if (text.startsWith("#")) {
    const raw = text.slice(1);
    const full =
      raw.length === 3
        ? raw
            .split("")
            .map((part) => part + part)
            .join("")
        : raw;
    return {
      r: Number.parseInt(full.slice(0, 2), 16),
      g: Number.parseInt(full.slice(2, 4), 16),
      b: Number.parseInt(full.slice(4, 6), 16),
    };
  }
  const match = text.match(
    /rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)/,
  );
  if (!match) throw new Error(`Unparsed color ${value}`);
  const alpha = match[4] == null ? 1 : Number(match[4]);
  const fg = { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]) };
  const bg = background ?? { r: 0, g: 0, b: 0 };
  return {
    r: fg.r * alpha + bg.r * (1 - alpha),
    g: fg.g * alpha + bg.g * (1 - alpha),
    b: fg.b * alpha + bg.b * (1 - alpha),
  };
}

function contrast(foreground: RGB, background: RGB): number {
  const lighter = Math.max(luminance(foreground), luminance(background));
  const darker = Math.min(luminance(foreground), luminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

function luminance(color: RGB): number {
  const channel = (value: number) => {
    const scaled = value / 255;
    return scaled <= 0.04045 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}
