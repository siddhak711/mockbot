import { afterEach, expect, it } from "vitest";
import { GET as listToolkits } from "../app/api/connectors/composio/toolkits/route";
import { GET as oauthCallback } from "../app/connectors/oauth/callback/route";
import { POST as startOAuth } from "../app/api/connectors/oauth/start/route";
import { catalogById, composioConnectorTarget } from "../src/connectors/catalog";
import { setComposioBrokerForTests } from "../src/connectors/composio/broker";
import type { ComposioBroker, ComposioToolSummary } from "../src/connectors/composio/types";
import { resetAppContext, setAppContext } from "../src/context";
import { MockProvider } from "../src/llm";
import { refreshMcpTools } from "../src/mcp/sync";
import { ConversationStore } from "../src/store";
import { createDefaultTools } from "../src/tools/builtins";
import { ToolRegistry } from "../src/tools/registry";

afterEach(async () => {
  setComposioBrokerForTests(null);
  delete process.env.COMPOSIO_API_KEY;
  delete process.env.NATIVE_CATALOG_OAUTH;
  delete process.env.APP_ORIGIN;
  await resetAppContext();
});

it("connects Notion through Composio and executes the signed-in user's tools", async () => {
  process.env.APP_ORIGIN = "http://localhost:3000";
  process.env.COMPOSIO_API_KEY = "test-key";
  const calls: { userId: string; connectedAccountId: string; slug: string }[] = [];
  const broker = fakeBroker({
    redirectUrl: "https://connect.composio.dev/link/notion-test",
    connectedAccountId: "ca_notion_1",
    label: "Grove",
    tools: [
      {
        slug: "NOTION_SEARCH",
        description: "Search pages",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string", description: "Text" } },
        },
        readOnlyHint: true,
      },
      {
        slug: "NOTION_CREATE_PAGE",
        description: "Create a page",
        inputSchema: { type: "object", properties: { title: { type: "string" } } },
      },
    ],
    execute: async (input) => {
      calls.push({
        userId: input.userId,
        connectedAccountId: input.connectedAccountId,
        slug: input.slug,
      });
      return { content: JSON.stringify({ pages: ["Q2"] }), isError: false };
    },
  });
  setComposioBrokerForTests(broker);
  const store = await ConversationStore.open();
  setAppContext({
    store,
    provider: new MockProvider({ delayMs: 0 }),
    tools: createDefaultTools({}),
  });

  const start = await startOAuth(jsonRequest({ catalogId: "notion" }));
  expect(start.status).toBe(200);
  const started = (await start.json()) as { authorizeUrl?: string };
  expect(started.authorizeUrl).toBe("https://connect.composio.dev/link/notion-test");
  const authorize = new URL(started.authorizeUrl ?? "");
  expect(authorize.origin).toBe("https://connect.composio.dev");
  const callbackUrl = broker.lastCallback ?? "";
  const callback = new URL(callbackUrl);
  expect(callback.pathname).toBe("/connectors/oauth/callback");
  expect(callback.searchParams.get("catalogId")).toBe("notion");
  const state = callback.searchParams.get("state") ?? "";
  expect(state).toBeTruthy();

  const mismatch = await oauthCallback(
    new Request(
      `http://localhost:3000/connectors/oauth/callback?status=success&connected_account_id=ca_notion_1&state=nope`,
      { headers: { cookie: cookiePair(start) } },
    ),
  );
  expect(mismatch.status).toBe(400);
  expect(await mismatch.text()).toContain("state did not match");
  expect(await store.listConnectors()).toHaveLength(0);

  const again = await startOAuth(jsonRequest({ catalogId: "notion" }));
  const againCallback = new URL(broker.lastCallback ?? "");
  const againState = againCallback.searchParams.get("state");
  const finished = await oauthCallback(
    new Request(
      `http://localhost:3000/connectors/oauth/callback?status=success&connected_account_id=ca_notion_1&state=${againState}&catalogId=notion`,
      { headers: { cookie: cookiePair(again) } },
    ),
  );
  const html = await finished.text();
  expect(finished.status).toBe(200);
  expect(html).toContain("Grove is connected");
  expect(html).not.toContain("ca_notion_1");
  const connectors = await store.listConnectors();
  expect(connectors).toHaveLength(1);
  const connector = connectors[0];
  expect(connector?.catalogId).toBe("notion");
  expect(connector?.target).toBe(composioConnectorTarget("notion"));
  expect(connector?.secretCipher).toBeNull();
  expect(connector?.accountLabel).toBe("Grove");
  expect(connector?.tools?.NOTION_SEARCH).toMatchObject({
    enabled: true,
    approval: "auto",
    risk: "read",
  });
  expect(connector?.tools?.NOTION_CREATE_PAGE).toMatchObject({ enabled: false, approval: "ask" });

  const owner = await store.getComposioConnection("user_test", "notion");
  expect(owner).toMatchObject({
    toolkit: "notion",
    connectedAccountId: "ca_notion_1",
    accountLabel: "Grove",
    status: "connected",
  });

  const other = await store.upsertComposioConnection({
    userId: "user_other",
    catalogId: "notion",
    toolkit: "notion",
    connectedAccountId: "ca_notion_other",
    accountLabel: "Other",
    status: "connected",
  });
  expect(other.connectedAccountId).toBe("ca_notion_other");
  expect((await store.getComposioConnection("user_test", "notion"))?.connectedAccountId).toBe(
    "ca_notion_1",
  );

  const stranger = new ToolRegistry();
  await refreshMcpTools({
    registry: stranger,
    connectors,
    env: process.env,
    userId: "user_stranger",
  });
  expect(stranger.get("notion_NOTION_SEARCH")).toBeUndefined();

  const registry = new ToolRegistry();
  await refreshMcpTools({
    registry,
    connectors,
    env: process.env,
    userId: "user_test",
  });
  const tool = registry.get("notion_NOTION_SEARCH");
  const result = await tool?.invoke({ query: "Q2" }, {});
  expect(result?.isError).toBe(false);
  expect(result?.content).toContain("Q2");
  expect(calls).toEqual([
    { userId: "user_test", connectedAccountId: "ca_notion_1", slug: "NOTION_SEARCH" },
  ]);

  const listed = await listToolkits(
    new Request("http://localhost:3000/api/connectors/composio/toolkits"),
  );
  expect(listed.status).toBe(200);
  const body = (await listed.json()) as {
    toolkits: { slug: string; name: string }[];
    catalog: { id: string; toolkit: string | null; enabled: boolean }[];
  };
  expect(body.toolkits.map((item) => item.slug)).toEqual(["github", "notion"]);
  const notion = body.catalog.find((item) => item.id === "notion");
  const slack = body.catalog.find((item) => item.id === "slack");
  expect(notion).toMatchObject({ toolkit: "notion", enabled: true });
  expect(slack).toMatchObject({ toolkit: "slack", enabled: false });
  expect(catalogById("github")?.composio).toEqual({ toolkit: "github", enabled: true });
});

it("rejects a failed Composio sign-in without storing a connection", async () => {
  process.env.APP_ORIGIN = "http://localhost:3000";
  process.env.COMPOSIO_API_KEY = "test-key";
  const broker = fakeBroker({
    redirectUrl: "https://connect.composio.dev/link/github-test",
    connectedAccountId: "ca_github_1",
    label: "octocat",
    ownerId: "user_test",
  });
  setComposioBrokerForTests(broker);
  const store = await ConversationStore.open();
  setAppContext({
    store,
    provider: new MockProvider({ delayMs: 0 }),
    tools: createDefaultTools({}),
  });

  const start = await startOAuth(jsonRequest({ catalogId: "github" }));
  const callback = new URL(broker.lastCallback ?? "");
  const state = callback.searchParams.get("state");
  const failed = await oauthCallback(
    new Request(
      `http://localhost:3000/connectors/oauth/callback?status=failed&connected_account_id=ca_github_1&state=${state}`,
      { headers: { cookie: cookiePair(start) } },
    ),
  );
  expect(failed.status).toBe(400);
  expect(await failed.text()).toContain("did not finish sign-in");
  expect(await store.listConnectors()).toHaveLength(0);
  expect(await store.listComposioConnections("user_test")).toHaveLength(0);
});

function fakeBroker(options: {
  redirectUrl: string;
  connectedAccountId: string;
  label: string;
  ownerId?: string;
  tools?: ComposioToolSummary[];
  execute?: ComposioBroker["executeTool"];
}): ComposioBroker & { lastCallback?: string } {
  const broker: ComposioBroker & { lastCallback?: string } = {
    lastCallback: undefined,
    async listToolkits() {
      return [
        { slug: "github", name: "GitHub", description: "Repos" },
        { slug: "notion", name: "Notion", description: "Pages" },
      ];
    },
    async authorize(input) {
      broker.lastCallback = input.callbackUrl;
      return { redirectUrl: options.redirectUrl, connectedAccountId: options.connectedAccountId };
    },
    async getConnectedAccount(input) {
      if (options.ownerId && input.userId !== options.ownerId) {
        throw new Error("That Composio account is not connected for this user.");
      }
      if (input.connectedAccountId !== options.connectedAccountId) {
        throw new Error("That Composio account is not connected for this user.");
      }
      return { id: input.connectedAccountId, status: "ACTIVE", label: options.label };
    },
    async listTools() {
      return options.tools ?? [];
    },
    executeTool: options.execute ?? (async () => ({ content: "{}", isError: false })),
  };
  return broker;
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
