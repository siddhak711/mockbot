import { createServer, type Server } from "node:http";
import { afterEach, expect, it } from "vitest";
import { GET as oauthCallback } from "../app/connectors/oauth/callback/route";
import { POST as createConnector } from "../app/api/connectors/route";
import { POST as startOAuth } from "../app/api/connectors/oauth/start/route";
import { catalogById, catalogIsWired } from "../src/connectors/catalog";
import { openPending } from "../src/connectors/oauth/pending";
import { parseOAuthToken, refreshStoredOAuthToken } from "../src/connectors/oauth/token";
import { resetAppContext, setAppContext } from "../src/context";
import { MockProvider } from "../src/llm";
import { refreshMcpTools } from "../src/mcp/sync";
import { decryptSecret, encryptSecret } from "../src/mcp/vault";
import { ConversationStore } from "../src/store";
import { createDefaultTools } from "../src/tools/builtins";
import { ToolRegistry } from "../src/tools/registry";
import { startMockMcpServer } from "../scripts/mock-mcp-server.mjs";

afterEach(async () => {
  await resetAppContext();
});

it("marks only Notion and GitHub as connectable catalog providers", () => {
  expect(catalogIsWired(catalogById("notion")!)).toBe(true);
  expect(catalogIsWired(catalogById("github")!)).toBe(true);
  for (const id of ["linear", "slack", "google-drive", "postgres", "figma", "jira"]) {
    expect(catalogIsWired(catalogById(id)!), id).toBe(false);
  }
});

it("refuses a catalog connect when the provider is unwired or missing credentials", async () => {
  const slack = await startOAuth(jsonRequest({ catalogId: "slack" }));
  expect(slack.status).toBe(400);
  expect(await slack.json()).toEqual({ error: "Slack is not available yet." });

  const previousId = process.env.NOTION_OAUTH_CLIENT_ID;
  const previousSecret = process.env.NOTION_OAUTH_CLIENT_SECRET;
  delete process.env.NOTION_OAUTH_CLIENT_ID;
  delete process.env.NOTION_OAUTH_CLIENT_SECRET;
  try {
    const missing = await startOAuth(jsonRequest({ catalogId: "notion" }));
    const body = (await missing.json()) as { error?: string };
    expect(missing.status).toBe(400);
    expect(body.error).toContain("NOTION_OAUTH_CLIENT_ID");
    expect(body.error).toContain("NOTION_OAUTH_CLIENT_SECRET");
  } finally {
    restoreEnv("NOTION_OAUTH_CLIENT_ID", previousId);
    restoreEnv("NOTION_OAUTH_CLIENT_SECRET", previousSecret);
  }
});

it("starts Notion without PKCE and GitHub with S256 PKCE", async () => {
  withOAuthEnv();
  try {
    const notion = await startOAuth(jsonRequest({ catalogId: "notion" }));
    const notionBody = (await notion.json()) as { authorizeUrl?: string };
    expect(notion.status).toBe(200);
    const notionUrl = new URL(notionBody.authorizeUrl ?? "");
    expect(notionUrl.origin + notionUrl.pathname).toBe("https://api.notion.com/v1/oauth/authorize");
    expect(notionUrl.searchParams.get("client_id")).toBe("notion-client");
    expect(notionUrl.searchParams.get("response_type")).toBe("code");
    expect(notionUrl.searchParams.get("owner")).toBe("user");
    expect(notionUrl.searchParams.get("redirect_uri")).toBe(
      "http://localhost:3000/connectors/oauth/callback",
    );
    expect(notionUrl.searchParams.get("code_challenge")).toBeNull();
    const notionPending = await openPending(cookieValue(notion));
    expect(notionPending?.verifier).toBeUndefined();
    expect(notionPending?.state).toBe(notionUrl.searchParams.get("state"));

    const github = await startOAuth(jsonRequest({ catalogId: "github" }));
    const githubBody = (await github.json()) as { authorizeUrl?: string };
    const githubUrl = new URL(githubBody.authorizeUrl ?? "");
    expect(githubUrl.origin + githubUrl.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(githubUrl.searchParams.get("scope")).toBe("repo read:org read:user");
    expect(githubUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(githubUrl.searchParams.get("code_challenge")).toBeTruthy();
    const githubPending = await openPending(cookieValue(github));
    expect(githubPending?.verifier).toBeTruthy();
    expect(githubUrl.searchParams.get("code_challenge")).not.toBe(githubPending?.verifier);
  } finally {
    clearOAuthEnv();
  }
});

it("exchanges a Notion code, stores the real token, and rejects a mismatched state", async () => {
  withOAuthEnv();
  const store = await ConversationStore.open();
  setAppContext({
    store,
    provider: new MockProvider({ delayMs: 0 }),
    tools: createDefaultTools({}),
  });
  const original = globalThis.fetch;
  globalThis.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const url = requestUrl(input);
    if (url !== "https://api.notion.com/v1/oauth/token") {
      throw new Error(`unexpected fetch ${url}`);
    }
    const authorization = headerValue(init?.headers, "authorization");
    expect(authorization).toBe(
      `Basic ${Buffer.from("notion-client:notion-secret").toString("base64")}`,
    );
    const body = JSON.parse(String(init?.body)) as Record<string, string>;
    expect(body).toEqual({
      grant_type: "authorization_code",
      code: "notion-code",
      redirect_uri: "http://localhost:3000/connectors/oauth/callback",
    });
    expect(JSON.stringify(body)).not.toContain("notion-secret");
    return new Response(
      JSON.stringify({
        access_token: "ntn_access",
        refresh_token: "ntn_refresh",
        workspace_name: "Grove",
        token_type: "bearer",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  try {
    const start = await startOAuth(jsonRequest({ catalogId: "notion" }));
    const started = (await start.json()) as { authorizeUrl: string };
    const state = new URL(started.authorizeUrl).searchParams.get("state");
    const mismatch = await oauthCallback(
      new Request(`http://localhost:3000/connectors/oauth/callback?code=notion-code&state=nope`, {
        headers: { cookie: cookiePair(start) },
      }),
    );
    expect(mismatch.status).toBe(400);
    expect(await mismatch.text()).toContain("state did not match");
    expect(await store.listConnectors()).toHaveLength(0);

    const again = await startOAuth(jsonRequest({ catalogId: "notion" }));
    const againBody = (await again.json()) as { authorizeUrl: string };
    const againState = new URL(againBody.authorizeUrl).searchParams.get("state");
    const callback = await oauthCallback(
      new Request(
        `http://localhost:3000/connectors/oauth/callback?code=notion-code&state=${againState}`,
        { headers: { cookie: cookiePair(again) } },
      ),
    );
    const html = await callback.text();
    expect(callback.status).toBe(200);
    expect(html).toContain("Grove is connected");
    expect(html).not.toContain("ntn_access");
    expect(html).not.toContain("ntn_refresh");
    expect(html).toContain("mockbot-oauth");
    const connectors = await store.listConnectors();
    expect(connectors).toHaveLength(1);
    const connector = connectors[0];
    expect(connector?.catalogId).toBe("notion");
    expect(connector?.target).toBe("https://api.notion.com/v1");
    expect(connector?.accountLabel).toBe("Grove");
    expect(connector?.authType).toBe("oauth");
    expect(connector?.tools?.search).toMatchObject({
      enabled: true,
      approval: "auto",
      risk: "read",
    });
    expect(connector?.tools?.create_page).toMatchObject({ enabled: false, approval: "ask" });
    const stored = parseOAuthToken(await decryptSecret(connector?.secretCipher ?? ""));
    expect(stored?.accessToken).toBe("ntn_access");
    expect(stored?.refreshToken).toBe("ntn_refresh");
    expect(state).not.toBe(againState);
  } finally {
    globalThis.fetch = original;
    clearOAuthEnv();
  }
});

it("exchanges a GitHub code with PKCE and points the connector at the hosted MCP server", async () => {
  withOAuthEnv();
  const store = await ConversationStore.open();
  setAppContext({
    store,
    provider: new MockProvider({ delayMs: 0 }),
    tools: createDefaultTools({}),
  });
  const original = globalThis.fetch;
  let verifier = "";
  globalThis.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const url = requestUrl(input);
    if (url === "https://github.com/login/oauth/access_token") {
      const params = new URLSearchParams(String(init?.body));
      expect(params.get("grant_type")).toBe("authorization_code");
      expect(params.get("code")).toBe("github-code");
      expect(params.get("code_verifier")).toBe(verifier);
      expect(params.get("client_id")).toBe("github-client");
      expect(params.get("client_secret")).toBe("github-secret");
      expect(params.get("redirect_uri")).toBe("http://localhost:3000/connectors/oauth/callback");
      return new Response(
        JSON.stringify({
          access_token: "gho_access",
          refresh_token: "gho_refresh",
          expires_in: 28800,
          scope: "repo read:org read:user",
          token_type: "bearer",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url === "https://api.github.com/user") {
      expect(headerValue(init?.headers, "authorization")).toBe("Bearer gho_access");
      return new Response(JSON.stringify({ login: "octocat" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("unauthorized", { status: 401 });
  }) as typeof fetch;
  try {
    const start = await startOAuth(jsonRequest({ catalogId: "github" }));
    const body = (await start.json()) as { authorizeUrl: string };
    const pending = await openPending(cookieValue(start));
    verifier = pending?.verifier ?? "";
    const state = new URL(body.authorizeUrl).searchParams.get("state");
    const callback = await oauthCallback(
      new Request(
        `http://localhost:3000/connectors/oauth/callback?code=github-code&state=${state}`,
        { headers: { cookie: cookiePair(start) } },
      ),
    );
    const html = await callback.text();
    expect(callback.status, html).toBe(200);
    expect(html).toContain("octocat is connected");
    expect(html).not.toContain("gho_access");
    const connector = (await store.listConnectors())[0];
    expect(connector?.target).toBe("https://api.githubcopilot.com/mcp/");
    expect(connector?.accountLabel).toBe("octocat");
    expect(connector?.status).toBe("error");
    const stored = parseOAuthToken(await decryptSecret(connector?.secretCipher ?? ""));
    expect(stored?.accessToken).toBe("gho_access");
    expect(stored?.refreshToken).toBe("gho_refresh");
    expect(stored?.expiresAt).toBeGreaterThan(Date.now());
  } finally {
    globalThis.fetch = original;
    clearOAuthEnv();
  }
});

it("refreshes an expired catalog token and keeps the rotated refresh token", async () => {
  withOAuthEnv();
  const fetched = await refreshStoredOAuthToken({
    catalogId: "notion",
    now: 1_000_000,
    token: {
      v: 1,
      kind: "oauth",
      accessToken: "ntn_old",
      refreshToken: "ntn_refresh",
      expiresAt: 1_000,
    },
    env: process.env,
    fetchImpl: (async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const body = JSON.parse(String(init?.body)) as Record<string, string>;
      expect(body.grant_type).toBe("refresh_token");
      expect(body.refresh_token).toBe("ntn_refresh");
      expect(headerValue(init?.headers, "authorization")).toBe(
        `Basic ${Buffer.from("notion-client:notion-secret").toString("base64")}`,
      );
      return new Response(
        JSON.stringify({ access_token: "ntn_new", refresh_token: "ntn_rotated", expires_in: 120 }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch,
  });
  expect(fetched.refreshed).toBe(true);
  expect(fetched.token.accessToken).toBe("ntn_new");
  expect(fetched.token.refreshToken).toBe("ntn_rotated");
  expect(fetched.token.expiresAt).toBe(1_000_000 + 120_000);

  const fresh = await refreshStoredOAuthToken({
    catalogId: "notion",
    now: 1_000_000,
    token: { ...fetched.token, expiresAt: 1_000_000 + 3_600_000 },
    env: process.env,
    fetchImpl: (async () => {
      throw new Error("should not refresh");
    }) as typeof fetch,
  });
  expect(fresh.refreshed).toBe(false);
  clearOAuthEnv();
});

it("calls the Notion API with the stored token instead of echoing arguments", async () => {
  withOAuthEnv();
  const store = await ConversationStore.open();
  setAppContext({
    store,
    provider: new MockProvider({ delayMs: 0 }),
    tools: createDefaultTools({}),
  });
  const seen: { authorization?: string; body?: string }[] = [];
  const server = await listen((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      seen.push({
        authorization: req.headers.authorization,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ results: [{ title: "Q2 plan" }] }));
    });
  });
  try {
    await store.createConnector({
      name: "Notion",
      transport: "http",
      target: server.url,
      secretRef: null,
      catalogId: "notion",
      authType: "oauth",
      secretCipher: await encryptSecret(
        JSON.stringify({
          v: 1,
          kind: "oauth",
          accessToken: "ntn_live",
          refreshToken: "ntn_refresh",
          expiresAt: Date.now() + 3_600_000,
        }),
      ),
      tools: {},
    });
    const registry = new ToolRegistry();
    await refreshMcpTools({ registry, connectors: await store.listConnectors(), env: process.env });
    expect(registry.get("notion_search_pages")).toBeUndefined();
    const search = registry.get("notion_search");
    expect(search?.approval).toBe("never");
    const result = await search?.invoke({ query: "Q2" }, {});
    expect(result?.isError).toBe(false);
    expect(result?.content).toContain("Q2 plan");
    expect(result?.content).not.toContain('"arguments"');
    expect(seen[0]?.authorization).toBe("Bearer ntn_live");
    expect(seen[0]?.body).toContain("Q2");
  } finally {
    await server.close();
    clearOAuthEnv();
  }
});

it("refreshes before a Notion call when the access token is expired", async () => {
  withOAuthEnv();
  const store = await ConversationStore.open();
  setAppContext({
    store,
    provider: new MockProvider({ delayMs: 0 }),
    tools: createDefaultTools({}),
  });
  const seen: string[] = [];
  const server = await listen((req, res) => {
    seen.push(req.headers.authorization ?? "");
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ results: [{ title: "refreshed page" }] }));
  });
  const original = globalThis.fetch;
  globalThis.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const url = requestUrl(input);
    if (url.startsWith("https://api.notion.com/v1/oauth/token")) {
      const body = JSON.parse(String(init?.body)) as { refresh_token?: string };
      expect(body.refresh_token).toBe("ntn_refresh");
      return new Response(
        JSON.stringify({ access_token: "ntn_new", refresh_token: "ntn_rotated", expires_in: 3600 }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return original(input, init);
  }) as typeof fetch;
  try {
    await store.createConnector({
      name: "Notion",
      transport: "http",
      target: server.url,
      secretRef: null,
      catalogId: "notion",
      authType: "oauth",
      secretCipher: await encryptSecret(
        JSON.stringify({
          v: 1,
          kind: "oauth",
          accessToken: "ntn_old",
          refreshToken: "ntn_refresh",
          expiresAt: Date.now() - 5_000,
        }),
      ),
      tools: {},
    });
    const registry = new ToolRegistry();
    await refreshMcpTools({ registry, connectors: await store.listConnectors(), env: process.env });
    const result = await registry.get("notion_search")?.invoke({ query: "plan" }, {});
    expect(result?.content).toContain("refreshed page");
    expect(seen).toEqual(["Bearer ntn_new"]);
    const stored = parseOAuthToken(
      await decryptSecret((await store.listConnectors())[0]?.secretCipher ?? ""),
    );
    expect(stored?.accessToken).toBe("ntn_new");
    expect(stored?.refreshToken).toBe("ntn_rotated");
  } finally {
    globalThis.fetch = original;
    await server.close();
    clearOAuthEnv();
  }
});

it("refreshes once after Notion returns 401 and retries the tool", async () => {
  withOAuthEnv();
  const store = await ConversationStore.open();
  setAppContext({
    store,
    provider: new MockProvider({ delayMs: 0 }),
    tools: createDefaultTools({}),
  });
  const seen: string[] = [];
  const server = await listen((req, res) => {
    seen.push(req.headers.authorization ?? "");
    if (seen.length === 1) {
      res.statusCode = 401;
      res.end(JSON.stringify({ message: "unauthorized" }));
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ results: [{ title: "after refresh" }] }));
  });
  const original = globalThis.fetch;
  globalThis.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const url = requestUrl(input);
    if (url.startsWith("https://api.notion.com/v1/oauth/token")) {
      return new Response(
        JSON.stringify({
          access_token: "ntn_retry",
          refresh_token: "ntn_rotated",
          expires_in: 3600,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return original(input, init);
  }) as typeof fetch;
  try {
    await store.createConnector({
      name: "Notion",
      transport: "http",
      target: server.url,
      secretRef: null,
      catalogId: "notion",
      authType: "oauth",
      secretCipher: await encryptSecret(
        JSON.stringify({
          v: 1,
          kind: "oauth",
          accessToken: "ntn_stale",
          refreshToken: "ntn_refresh",
          expiresAt: Date.now() + 3_600_000,
        }),
      ),
      tools: {},
    });
    const registry = new ToolRegistry();
    await refreshMcpTools({ registry, connectors: await store.listConnectors(), env: process.env });
    const result = await registry.get("notion_search")?.invoke({ query: "plan" }, {});
    expect(result?.isError).toBe(false);
    expect(result?.content).toContain("after refresh");
    expect(seen).toEqual(["Bearer ntn_stale", "Bearer ntn_retry"]);
  } finally {
    globalThis.fetch = original;
    await server.close();
    clearOAuthEnv();
  }
});

it("routes a GitHub catalog connector through the MCP client", async () => {
  const server = await startMockMcpServer();
  const store = await ConversationStore.open();
  setAppContext({
    store,
    provider: new MockProvider({ delayMs: 0 }),
    tools: createDefaultTools({}),
  });
  try {
    await store.createConnector({
      name: "GitHub",
      transport: "http",
      target: server.url,
      secretRef: null,
      catalogId: "github",
      authType: "oauth",
      secretCipher: await encryptSecret(
        JSON.stringify({ v: 1, kind: "oauth", accessToken: "gho_test" }),
      ),
      tools: {},
    });
    const registry = new ToolRegistry();
    await refreshMcpTools({ registry, connectors: await store.listConnectors(), env: process.env });
    expect(registry.get("github_list_issues")).toBeUndefined();
    const echo = registry.get("github_echo");
    const result = await echo?.invoke({ message: "from-github" }, {});
    expect(result?.isError).toBe(false);
    expect(result?.content).toContain("from-github");
    expect(result?.content).toContain("mock-mcp");
    expect(result?.content).not.toContain('"connector":"GitHub"');
  } finally {
    await server.close();
  }
});

it("does not execute a legacy simulated catalog connector", async () => {
  const store = await ConversationStore.open();
  setAppContext({
    store,
    provider: new MockProvider({ delayMs: 0 }),
    tools: createDefaultTools({}),
  });
  await store.createConnector({
    name: "Notion",
    transport: "http",
    target: "https://catalog.mockbot.local/notion",
    secretRef: null,
    catalogId: "notion",
    authType: "oauth",
    secretCipher: await encryptSecret("not-a-real-token"),
    tools: {
      search_pages: {
        enabled: true,
        approval: "auto",
        risk: "read",
        description: "Search pages",
      },
    },
  });
  const registry = new ToolRegistry();
  await refreshMcpTools({ registry, connectors: await store.listConnectors(), env: process.env });
  expect(registry.get("notion_search_pages")).toBeUndefined();
  expect(registry.get("notion_search")).toBeUndefined();
});

it("does not mint a catalog connector from the old catalog POST", async () => {
  const store = await ConversationStore.open();
  setAppContext({
    store,
    provider: new MockProvider({ delayMs: 0 }),
    tools: createDefaultTools({}),
  });
  const response = await createConnector(
    new Request("http://localhost/api/connectors", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ catalogId: "slack", accountLabel: "workspace" }),
    }),
  );
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "Slack is not available yet." });
  expect(await store.listConnectors()).toHaveLength(0);
});

function withOAuthEnv(): void {
  process.env.APP_ORIGIN = "http://localhost:3000";
  process.env.NOTION_OAUTH_CLIENT_ID = "notion-client";
  process.env.NOTION_OAUTH_CLIENT_SECRET = "notion-secret";
  process.env.GITHUB_OAUTH_CLIENT_ID = "github-client";
  process.env.GITHUB_OAUTH_CLIENT_SECRET = "github-secret";
}

function clearOAuthEnv(): void {
  delete process.env.APP_ORIGIN;
  delete process.env.NOTION_OAUTH_CLIENT_ID;
  delete process.env.NOTION_OAUTH_CLIENT_SECRET;
  delete process.env.GITHUB_OAUTH_CLIENT_ID;
  delete process.env.GITHUB_OAUTH_CLIENT_SECRET;
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value == null) delete process.env[name];
  else process.env[name] = value;
}

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost:3000/api/connectors/oauth/start", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function cookiePair(response: Response): string {
  const raw = response.headers.get("set-cookie");
  if (!raw) throw new Error("missing oauth cookie");
  return raw.split(";")[0] ?? "";
}

function cookieValue(response: Response): string {
  const pair = cookiePair(response);
  return pair.slice(pair.indexOf("=") + 1);
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function headerValue(headers: HeadersInit | undefined, name: string): string {
  if (!headers) return "";
  if (headers instanceof Headers) return headers.get(name) ?? "";
  if (Array.isArray(headers)) {
    const found = headers.find(([key]) => key.toLowerCase() === name.toLowerCase());
    return found?.[1] ?? "";
  }
  const record = headers as Record<string, string>;
  const key = Object.keys(record).find((item) => item.toLowerCase() === name.toLowerCase());
  return key ? (record[key] ?? "") : "";
}

function listen(
  handler: (
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
  ) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer(handler);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("missing port"));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () =>
          new Promise((done, fail) => {
            server.close((error) => (error ? fail(error) : done()));
          }),
      });
    });
  });
}
