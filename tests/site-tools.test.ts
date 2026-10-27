import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { chromium, type Browser as CdpBrowser } from "playwright-core";
import { afterEach, expect, it } from "vitest";
import type { BrowserSessionSource, RemoteBrowserSession } from "../src/browser/browserbase";
import type { BrowserHost } from "../src/browser/sandbox-browser";
import { SandboxBrowser } from "../src/browser/sandbox-browser";
import { MIGRATIONS } from "../src/db/migrations";
import type { LlmProvider } from "../src/llm";
import type { ExecOutcome } from "../src/sandbox/runtime";
import { streamChatTurn } from "../src/chat";
import { compileSiteTool } from "../src/site-tools/compile";
import { mintSiteTool, runSiteTool } from "../src/site-tools/mint";
import { reviewScript } from "../src/site-tools/review";
import { runPlaywrightScript } from "../src/site-tools/run-script";
import { SiteToolRepository } from "../src/site-tools/repository";
import { createSiteTools } from "../src/site-tools/tools";
import type { ScriptRunRequest, SiteBrowser, SiteToolDeps } from "../src/site-tools/types";
import { SseParser } from "../src/sse";
import { ConversationStore } from "../src/store";
import { ApprovalGate } from "../src/tools/approval";
import { AskGate } from "../src/tools/ask-user";
import { PlanGate } from "../src/tools/plan";
import { ToolRegistry } from "../src/tools/registry";
import type { BrowseStep } from "../src/browser/types";
import type { LlmMessage, LlmStreamEvent } from "../src/types";

const REPO_MODULES = resolve(__dirname, "../node_modules");
const openStores: ConversationStore[] = [];

afterEach(async () => {
  await Promise.all(openStores.splice(0).map((store) => store.close()));
});

async function openStore(): Promise<ConversationStore> {
  const store = await ConversationStore.open();
  openStores.push(store);
  return store;
}

async function addUser(store: ConversationStore, id: string): Promise<void> {
  await store.connection.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [
    id,
    `${id}@example.com`,
  ]);
}

async function toolCount(store: ConversationStore, userId: string): Promise<number> {
  const result = await store.connection.query<{ count: number | string }>(
    `SELECT COUNT(*) AS count FROM site_tools WHERE user_id = $1`,
    [userId],
  );
  return Number(result.rows[0]?.count ?? 0);
}

function fakeDriver(text = "$42.17"): SiteBrowser & { steps: BrowseStep[] } {
  const steps: BrowseStep[] = [];
  return {
    steps,
    async perform(step) {
      steps.push(step);
      if (step.action === "open") return { ok: true, url: step.url, title: "Fixture", status: 200 };
      if (step.action === "extract") return { ok: true, text, url: step.url, title: "Fixture" };
      if (step.action === "click" || step.action === "type") {
        return { ok: true, url: step.url, title: "Fixture" };
      }
      return { ok: false, error: "unexpected" };
    },
  };
}

function depsFor(
  store: ConversationStore,
  driver: SiteBrowser | null,
  extra: Partial<SiteToolDeps> = {},
): SiteToolDeps {
  return {
    repository: new SiteToolRepository(store.connection),
    driver: () => driver,
    host: () => null,
    paths: { node: process.execPath, nodePath: REPO_MODULES },
    env: {},
    ...extra,
  };
}

it("applies the site_tools migration", async () => {
  const store = await openStore();
  const applied = await store.connection.query<{ id: string }>(
    `SELECT id FROM schema_migrations WHERE id = '013_site_tools'`,
  );
  expect(applied.rows.map((row) => row.id)).toEqual(["013_site_tools"]);
  const columns = await store.connection.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'site_tools'`,
  );
  expect(columns.rows.map((row) => row.column_name).sort()).toEqual(
    ["created_at", "id", "name", "schema", "script", "user_id", "version"].sort(),
  );
});

it("mints a Playwright script with a typed selector schema after browse explores the site", async () => {
  const store = await openStore();
  await addUser(store, "user_a");
  const driver = fakeDriver();
  const seen: ScriptRunRequest[] = [];
  const minted = await mintSiteTool(
    { userId: "user_a", site: "https://shop.example/item", task: "Extract the text of #price" },
    depsFor(store, driver, {
      runScript: async (request) => {
        seen.push(request);
        return { ok: true, result: { text: "$42.17" } };
      },
    }),
  );
  expect(minted.saved).toBe(true);
  if (!minted.saved) return;
  expect(minted.version).toBe(1);
  expect(minted.explored).toEqual(["open", "extract"]);
  expect(minted.schema.required).toEqual(["selector"]);
  expect(minted.schema.properties.selector?.type).toBe("string");
  expect(minted.sampleArgs).toEqual({ selector: "#price" });
  expect(minted.review.reviewer).toBe("heuristic");
  expect(minted.run.result).toEqual({ text: "$42.17" });
  expect(seen[0]?.script).toContain('require("playwright-core")');
  expect(seen[0]?.script).toContain("https://shop.example/item");
  expect(seen[0]?.script).toContain("async function run");
  expect(seen[0]?.args).toEqual({ selector: "#price" });
  expect(driver.steps.map((step) => step.action)).toEqual(["open", "extract"]);
  expect(driver.steps[0]).toMatchObject({ action: "open", timeoutMs: 20_000, allowSubmit: false });
  expect(driver.steps[1]).toMatchObject({ selector: "#price" });
});

it("does not save a script that fails its live-site run", async () => {
  const store = await openStore();
  await addUser(store, "user_a");
  const driver = fakeDriver();
  let reviewed = false;
  const minted = await mintSiteTool(
    { userId: "user_a", site: "https://shop.example/item", task: "Extract the text of #price" },
    depsFor(store, driver, {
      reviewer: async () => {
        reviewed = true;
        return { ok: true, reviewer: "injected" };
      },
      runScript: async () => ({ ok: false, error: "selector missing" }),
    }),
  );
  expect(reviewed).toBe(true);
  expect(minted).toMatchObject({ saved: false, stage: "run" });
  expect(await toolCount(store, "user_a")).toBe(0);
  expect(
    await new SiteToolRepository(store.connection).latest("user_a", "extract_the_text_of_price"),
  ).toBeNull();
});

it("does not save when the self-check review rejects the script", async () => {
  const store = await openStore();
  await addUser(store, "user_a");
  let ran = false;
  const minted = await mintSiteTool(
    { userId: "user_a", site: "https://shop.example/item", task: "Extract the text of #price" },
    depsFor(store, fakeDriver(), {
      reviewer: async () => ({
        ok: false,
        reviewer: "injected",
        reason: "does not match the task",
      }),
      runScript: async () => {
        ran = true;
        return { ok: true, result: { text: "$42.17" } };
      },
    }),
  );
  expect(ran).toBe(false);
  expect(minted).toMatchObject({
    saved: false,
    stage: "review",
    error: expect.stringContaining("does not match the task"),
  });
  expect(await toolCount(store, "user_a")).toBe(0);
});

it("lets the cheap self-check model reject a script before it is saved", async () => {
  const store = await openStore();
  await addUser(store, "user_a");
  let ran = false;
  const models: string[] = [];
  const minted = await mintSiteTool(
    { userId: "user_a", site: "https://shop.example/item", task: "Extract the text of #price" },
    depsFor(store, fakeDriver(), {
      env: {
        LLM_API_KEY: "sk-test",
        LLM_BASE_URL: "http://review.example/v1",
        SITE_TOOL_REVIEW_MODEL: "gpt-4o-mini",
      },
      fetchImpl: async (url, init) => {
        models.push(String(url));
        const body = JSON.parse(String(init?.body)) as { model?: string; messages?: unknown[] };
        expect(body.model).toBe("gpt-4o-mini");
        expect(JSON.stringify(body.messages)).toContain("playwright-core");
        return Response.json({
          choices: [{ message: { content: '{"ok":false,"reason":"navigates away"}' } }],
        });
      },
      runScript: async () => {
        ran = true;
        return { ok: true, result: { text: "$42.17" } };
      },
    }),
  );
  expect(models).toEqual(["http://review.example/v1/chat/completions"]);
  expect(ran).toBe(false);
  expect(minted).toMatchObject({ saved: false, stage: "review" });
  expect(await toolCount(store, "user_a")).toBe(0);
});

it("saves when the cheap self-check model approves a script that also runs", async () => {
  const store = await openStore();
  await addUser(store, "user_a");
  const minted = await mintSiteTool(
    { userId: "user_a", site: "https://shop.example/item", task: "Extract the text of #price" },
    depsFor(store, fakeDriver(), {
      env: {
        LLM_API_KEY: "sk-test",
        LLM_BASE_URL: "http://review.example/v1",
        SITE_TOOL_REVIEW_MODEL: "gpt-4o-mini",
      },
      fetchImpl: async () => Response.json({ choices: [{ message: { content: '{"ok":true}' } }] }),
      runScript: async () => ({ ok: true, result: { text: "$42.17" } }),
    }),
  );
  expect(minted.saved).toBe(true);
  if (!minted.saved) return;
  expect(minted.review.reviewer).toBe("model");
  expect(await toolCount(store, "user_a")).toBe(1);
});

it("does not save when the model approves a script the offline check rejects", async () => {
  const verdict = await reviewScript(
    {
      site: "https://shop.example/item",
      task: "Extract the text of #price",
      name: "price",
      schema: {
        type: "object",
        properties: { selector: { type: "string" } },
        required: ["selector"],
        additionalProperties: false,
      },
      script:
        'eval("nope"); require("playwright-core"); async function run(){ return page.goto("https://shop.example/item"); }',
    },
    {
      env: { LLM_API_KEY: "sk-test", LLM_BASE_URL: "http://review.example/v1" },
      fetchImpl: async () => Response.json({ choices: [{ message: { content: '{"ok":true}' } }] }),
    },
  );
  expect(verdict.ok).toBe(false);
  if (!verdict.ok) expect(verdict.reason).toContain("forbidden");
});

it("bumps the version when the same site tool is minted again", async () => {
  const store = await openStore();
  await addUser(store, "user_a");
  const driver = fakeDriver();
  const pass = depsFor(store, driver, {
    runScript: async () => ({ ok: true, result: { text: "$42.17" } }),
  });
  const first = await mintSiteTool(
    {
      userId: "user_a",
      site: "https://shop.example/item",
      task: "Extract the text of #price",
      name: "price",
    },
    pass,
  );
  const second = await mintSiteTool(
    {
      userId: "user_a",
      site: "https://shop.example/item",
      task: "Extract the text of #stock",
      name: "price",
    },
    pass,
  );
  expect(first).toMatchObject({ saved: true, version: 1, name: "price" });
  expect(second).toMatchObject({ saved: true, version: 2, name: "price" });
  const repository = new SiteToolRepository(store.connection);
  expect(await repository.versions("user_a", "price")).toEqual([1, 2]);
  const latest = await repository.latest("user_a", "Price");
  expect(latest?.version).toBe(2);
  expect(latest?.script).toContain("Extract the text of #stock");
  expect(latest?.script).not.toContain("Extract the text of #price");
});

it("replays the latest script with typed args and refuses another user's copy", async () => {
  const store = await openStore();
  await addUser(store, "user_a");
  await addUser(store, "user_b");
  const seen: ScriptRunRequest[] = [];
  const pass = depsFor(store, fakeDriver(), {
    runScript: async (request) => {
      seen.push(request);
      return { ok: true, result: { text: `read ${request.args.selector}` } };
    },
  });
  await mintSiteTool(
    {
      userId: "user_a",
      site: "https://shop.example/item",
      task: "Extract the text of #price",
      name: "price",
    },
    pass,
  );
  await mintSiteTool(
    {
      userId: "user_a",
      site: "https://shop.example/item",
      task: "Extract the text of #stock",
      name: "price",
    },
    pass,
  );
  seen.length = 0;
  const ran = await runSiteTool(
    { userId: "user_a", name: "price", args: { selector: "#stock" } },
    pass,
  );
  expect(ran).toEqual({
    ok: true,
    name: "price",
    version: 2,
    result: { text: "read #stock" },
  });
  expect(seen).toHaveLength(1);
  expect(seen[0]?.args).toEqual({ selector: "#stock" });
  expect(seen[0]?.script).toContain("Extract the text of #stock");
  const missing = await runSiteTool({ userId: "user_a", name: "price", args: {} }, pass);
  expect(missing.ok).toBe(false);
  const other = await runSiteTool(
    { userId: "user_b", name: "price", args: { selector: "#stock" } },
    pass,
  );
  expect(other).toMatchObject({ ok: false });
  expect(seen).toHaveLength(1);
});

it("keeps a typed text input and does not save when the browser cannot explore", async () => {
  const store = await openStore();
  await addUser(store, "user_a");
  const driver = fakeDriver("Widget");
  const minted = await mintSiteTool(
    {
      userId: "user_a",
      site: "https://shop.example/search",
      task: "Type {query: widgets} into #search and extract the text of #results",
    },
    depsFor(store, driver, {
      runScript: async (request) => ({ ok: true, result: { args: request.args } }),
    }),
  );
  expect(minted.saved).toBe(true);
  if (!minted.saved) return;
  expect(minted.sampleArgs).toEqual({ query: "widgets" });
  expect(minted.schema.properties.query?.type).toBe("string");
  expect(driver.steps.map((step) => step.action)).toEqual(["open", "type", "extract"]);
  expect(driver.steps[1]).toMatchObject({ selector: "#search", text: "widgets" });

  const unavailable = await mintSiteTool(
    {
      userId: "user_a",
      site: "https://shop.example/item",
      task: "Extract the text of #price",
      name: "offline",
    },
    depsFor(store, null),
  );
  expect(unavailable).toMatchObject({ saved: false, stage: "explore" });
  expect(await new SiteToolRepository(store.connection).latest("user_a", "offline")).toBeNull();
});

it("applies every migration in order on a fresh database", async () => {
  const store = await openStore();
  const applied = await store.connection.query<{ id: string }>(
    `SELECT id FROM schema_migrations ORDER BY applied_at ASC, id ASC`,
  );
  const ids = applied.rows.map((row) => row.id);
  expect(ids).toEqual(MIGRATIONS.map((migration) => migration.id));
  expect(await store.migrationIds()).toEqual(ids);
  expect(ids).not.toContain("007_site_tools");
  expect(ids).toContain("013_site_tools");
  for (let index = 1; index < ids.length; index += 1) {
    expect(ids[index]! > ids[index - 1]!).toBe(true);
  }
});

it("asks the OpenRouter cheap tier instead of a bare gpt-4o-mini id", async () => {
  const compiled = compileSiteTool({
    site: "https://shop.example/item",
    task: "Extract the text of #price",
    steps: [{ op: "extract", selector: { kind: "arg", name: "selector", example: "#price" } }],
  });
  expect(compiled.ok).toBe(true);
  if (!compiled.ok) return;
  const input = {
    site: "https://shop.example/item",
    task: "Extract the text of #price",
    name: "price",
    schema: compiled.schema,
    script: compiled.script,
  };
  const bodies: Array<Record<string, unknown>> = [];
  const fetchImpl: typeof fetch = async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return Response.json({ choices: [{ message: { content: '{"ok":true}' } }] });
  };
  const cheap = await reviewScript(input, {
    env: { LLM_API_KEY: "sk-test", LLM_BASE_URL: "https://openrouter.ai/api/v1" },
    fetchImpl,
  });
  expect(cheap.ok).toBe(true);
  expect(bodies[0]?.model).toBe("openrouter/auto");
  expect(bodies[0]?.plugins).toEqual([{ id: "auto-router", cost_tier: "low" }]);
  expect(String(bodies[0]?.model)).not.toBe("gpt-4o-mini");

  const named = await reviewScript(input, {
    env: {
      LLM_API_KEY: "sk-test",
      LLM_BASE_URL: "https://openrouter.ai/api/v1",
      LLM_MODEL: "deepseek/deepseek-v4.1-flash",
    },
    fetchImpl,
  });
  expect(named.ok).toBe(true);
  expect(bodies[1]?.model).toBe("deepseek/deepseek-v4.1-flash");
  expect(bodies[1]?.plugins).toBeUndefined();
});

it("fails closed when the caller has no user id", async () => {
  const store = await openStore();
  const driver = fakeDriver();
  let ran = false;
  const [mint, run] = createSiteTools(
    depsFor(store, driver, {
      runScript: async () => {
        ran = true;
        return { ok: true, result: { text: "$42.17" } };
      },
    }),
  );
  const minted = await mint!.invoke(
    { site: "https://shop.example/item", task: "Extract the text of #price" },
    {},
  );
  const blank = await mint!.invoke(
    { site: "https://shop.example/item", task: "Extract the text of #price" },
    { userId: "" },
  );
  const replay = await run!.invoke({ name: "price" }, { userId: "   " });
  expect(minted).toMatchObject({ isError: true, content: expect.stringContaining("Sign in") });
  expect(blank.isError).toBe(true);
  expect(replay.isError).toBe(true);
  expect(driver.steps).toEqual([]);
  expect(ran).toBe(false);
  expect(await toolCount(store, "")).toBe(0);
});

it("asks for approval before a mint live run clicks a submit button", async () => {
  const store = await openStore();
  await addUser(store, "user_gate");
  const driver = fakeDriver();
  let ran = false;
  const tools = registryFor(store, driver, async () => {
    ran = true;
    return { ok: true, result: { text: "sent" } };
  });
  const approvals = new ApprovalGate();
  const model = new ScriptedModel((round) => {
    if (round === 0) {
      return [
        {
          id: "mint_submit",
          name: "mint_site_tool",
          args: {
            site: "https://shop.example/order",
            task: "Click button[type=submit]",
            name: "order",
          },
        },
      ];
    }
    return "Stopped.";
  });
  const response = await streamChatTurn({
    store,
    provider: model,
    tools,
    approvals,
    asks: new AskGate(),
    plans: new PlanGate(),
    message: "Place the order",
    userId: "user_gate",
  });
  const first = await readEvents(response, "approval_required");
  const approval = first.events.find((event) => event.event === "approval_required");
  expect(approval?.data).toMatchObject({ id: "mint_submit", name: "mint_site_tool" });
  expect(driver.steps).toEqual([]);
  expect(ran).toBe(false);

  approvals.decide("mint_submit", "deny");
  await drain(first.reader, first.parser, first.decoder);
  expect(driver.steps).toEqual([]);
  expect(ran).toBe(false);
  expect(await toolCount(store, "user_gate")).toBe(0);
});

it("asks for approval before replaying a script that clicks a label", async () => {
  const store = await openStore();
  await addUser(store, "user_gate");
  const compiled = compileSiteTool({
    site: "https://shop.example/order",
    task: "Click label[for=go]",
    steps: [{ op: "click", selector: { kind: "literal", value: "label[for=go]" } }],
  });
  expect(compiled.ok).toBe(true);
  if (!compiled.ok) return;
  await new SiteToolRepository(store.connection).save({
    userId: "user_gate",
    name: "order",
    schema: compiled.schema,
    script: compiled.script,
  });
  const driver = fakeDriver();
  let ran = false;
  const tools = registryFor(store, driver, async () => {
    ran = true;
    return { ok: true, result: { text: "sent" } };
  });
  const approvals = new ApprovalGate();
  const model = new ScriptedModel((round) => {
    if (round === 0) {
      return [{ id: "run_label", name: "run_site_tool", args: { name: "order" } }];
    }
    return "Stopped.";
  });
  const response = await streamChatTurn({
    store,
    provider: model,
    tools,
    approvals,
    asks: new AskGate(),
    plans: new PlanGate(),
    message: "Run the saved order tool",
    userId: "user_gate",
  });
  const first = await readEvents(response, "approval_required");
  expect(first.events.find((event) => event.event === "approval_required")?.data).toMatchObject({
    id: "run_label",
    name: "run_site_tool",
  });
  expect(ran).toBe(false);
  approvals.decide("run_label", "deny");
  await drain(first.reader, first.parser, first.decoder);
  expect(ran).toBe(false);
  expect(driver.steps).toEqual([]);
});

it("does not submit a form from a replay until the call is allowed", async () => {
  const posts: string[] = [];
  const server = createServer((req, res) => {
    if (req.method === "POST") {
      posts.push(req.url ?? "");
      res.end("ok");
      return;
    }
    res.setHeader("Content-Type", "text/html");
    res.end(`<!doctype html><form id="order" method="post" action="/order">
      <label for="go">Place order</label>
      <button id="go" type="submit">Place order</button>
    </form>`);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture port");
  const site = `http://127.0.0.1:${address.port}/`;
  const workspace = await mkdtemp(join(tmpdir(), "mockbot-site-submit-"));
  const host = localHost(workspace);
  const paths = { node: process.execPath, nodePath: REPO_MODULES };
  const remote = await localRemote();
  const sessions = remote.sessions;
  try {
    const button = compileSiteTool({
      site,
      task: "Click button[type=submit]",
      steps: [{ op: "click", selector: { kind: "literal", value: "button[type=submit]" } }],
    });
    const label = compileSiteTool({
      site,
      task: "Click label[for=go]",
      steps: [{ op: "click", selector: { kind: "literal", value: "label[for=go]" } }],
    });
    expect(button.ok && label.ok).toBe(true);
    if (!button.ok || !label.ok) return;
    const blocked = await runPlaywrightScript({
      host,
      paths,
      sessions,
      script: button.script,
      args: {},
      allowSubmit: false,
      timeoutMs: 20_000,
    });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.error).toContain("Nothing was submitted");
    const labeled = await runPlaywrightScript({
      host,
      paths,
      sessions,
      script: label.script,
      args: {},
      allowSubmit: false,
      timeoutMs: 20_000,
    });
    expect(labeled.ok).toBe(false);
    expect(posts).toEqual([]);
    const allowed = await runPlaywrightScript({
      host,
      paths,
      sessions,
      script: button.script,
      args: {},
      allowSubmit: true,
      timeoutMs: 20_000,
    });
    expect(allowed.ok).toBe(true);
    expect(posts).toEqual(["/order"]);
  } finally {
    await remote.browser.close();
    server.close();
    await rm(workspace, { recursive: true, force: true });
  }
}, 60_000);

it("registers hidden site tools the model can search for", () => {
  const registry = new ToolRegistry();
  for (const tool of createSiteTools({
    repository: {
      save: async () => {
        throw new Error("unused");
      },
      latest: async () => null,
    },
    driver: () => null,
    host: () => null,
    paths: { node: process.execPath, nodePath: REPO_MODULES },
    env: {},
  })) {
    registry.register(tool);
  }
  expect(registry.exposed().map((tool) => tool.name)).not.toContain("mint_site_tool");
  expect(
    registry
      .search("site tool")
      .map((tool) => tool.name)
      .sort(),
  ).toEqual(["mint_site_tool", "run_site_tool"]);
});

it("saves a script that passes on the live page and replays it with another selector", async () => {
  const server = createServer((_req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end(`<!doctype html><title>Fixture Store</title>
      <p id="price">$42.17</p>
      <p id="stock">In stock: 7</p>
      <button id="reveal" type="button" onclick="document.getElementById('secret').textContent='revealed'">Reveal</button>
      <p id="secret">hidden</p>`);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture port");
  const baseUrl = `http://127.0.0.1:${address.port}/`;
  const workspace = await mkdtemp(join(tmpdir(), "mockbot-site-tools-"));
  const host = localHost(workspace);
  const remote = await localRemote();
  const browser = new SandboxBrowser(host, {
    paths: { node: process.execPath, nodePath: REPO_MODULES },
    install: false,
    sessions: remote.sessions,
    port: await freePort(),
  });
  const liveDeps = {
    repository: new SiteToolRepository((await openStore()).connection),
    driver: () => browser,
    host: () => host,
    scriptSessions: () => remote.sessions,
    paths: { node: process.execPath, nodePath: REPO_MODULES },
    env: {},
    timeoutMs: 20_000,
  };
  try {
    const store = openStores.at(-1);
    if (!store) throw new Error("Expected a store");
    await addUser(store, "user_live");
    const deps = { ...liveDeps, repository: new SiteToolRepository(store.connection) };
    const minted = await mintSiteTool(
      { userId: "user_live", site: baseUrl, task: "Extract the text of #price", name: "price" },
      deps,
    );
    if (!minted.saved) throw new Error(`${minted.stage}: ${minted.error}`);
    expect(minted.version).toBe(1);
    expect(minted.review.reviewer).toBe("heuristic");
    expect(minted.run.result).toEqual({ text: "$42.17" });
    expect(minted.schema.required).toEqual(["selector"]);

    const stock = await runSiteTool(
      { userId: "user_live", name: "price", args: { selector: "#stock" } },
      deps,
    );
    expect(stock).toEqual({
      ok: true,
      name: "price",
      version: 1,
      result: { text: "In stock: 7" },
    });

    const again = await mintSiteTool(
      {
        userId: "user_live",
        site: baseUrl,
        task: "Click #reveal then extract the text of #secret",
        name: "price",
      },
      deps,
    );
    expect(again).toMatchObject({ saved: true, version: 2 });
    if (!again.saved) return;
    expect(again.run.result).toEqual({ text: "revealed" });
    expect(await new SiteToolRepository(store.connection).versions("user_live", "price")).toEqual([
      1, 2,
    ]);
  } finally {
    await browser.close();
    await remote.browser.close();
    server.close();
    await rm(workspace, { recursive: true, force: true });
  }
}, 60_000);

function registryFor(
  store: ConversationStore,
  driver: SiteBrowser,
  runScript: SiteToolDeps["runScript"],
): ToolRegistry {
  const tools = new ToolRegistry();
  for (const tool of createSiteTools(depsFor(store, driver, { runScript }))) {
    tools.register(tool);
  }
  return tools;
}

type Call = { id: string; name: string; args: Record<string, unknown> };

class ScriptedModel implements LlmProvider {
  readonly id = "mock" as const;
  readonly model = null;
  rounds = 0;

  constructor(private readonly script: (round: number) => Call[] | string) {}

  async *stream(_messages: LlmMessage[]): AsyncIterable<LlmStreamEvent> {
    const round = this.rounds;
    this.rounds += 1;
    const next = this.script(round);
    if (typeof next === "string") {
      yield { type: "text", text: next };
      yield { type: "end", finishReason: "stop" };
      return;
    }
    for (const [index, call] of next.entries()) {
      yield { type: "tool_call", index, id: call.id, name: call.name };
      yield { type: "tool_call", index, arguments: JSON.stringify(call.args) };
    }
    yield { type: "end", finishReason: "tool_calls" };
  }
}

type SseEvent = { event: string; data: Record<string, unknown> };

async function readEvents(response: Response, until?: string) {
  if (!response.body) throw new Error("Expected a response body");
  const parser = new SseParser();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events: SseEvent[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const message of parser.push(decoder.decode(value, { stream: true }))) {
      const event = {
        event: message.event,
        data: JSON.parse(message.data) as Record<string, unknown>,
      };
      events.push(event);
      if (until && event.event === until) return { events, reader, parser, decoder, done: false };
    }
  }
  return { events, reader, parser, decoder };
}

async function drain(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  parser: SseParser,
  decoder: TextDecoder,
): Promise<void> {
  while (true) {
    const { done, value } = await reader.read();
    if (done) return;
    parser.push(decoder.decode(value, { stream: true }));
  }
}

function localHost(root: string): BrowserHost {
  return {
    async write(path, content) {
      const target = join(root, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content);
      return { ok: true };
    },
    exec(command, timeoutMs) {
      return new Promise<ExecOutcome>((done) => {
        const child = spawn("sh", ["-c", command], { cwd: root });
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
        child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, timeoutMs);
        child.on("close", (code) => {
          clearTimeout(timer);
          done({ stdout, stderr, exitCode: timedOut ? null : code, timedOut });
        });
      });
    },
  };
}

async function freePort(): Promise<number> {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const address = probe.address();
  probe.close();
  if (!address || typeof address === "string") throw new Error("No port");
  return address.port;
}

/**
 * Stands in for Browserbase: a local Chromium that accepts CDP connections,
 * handed out as one long-lived session.
 */
class LocalSessions implements BrowserSessionSource {
  constructor(private readonly connectUrl: string) {}
  async acquire(): Promise<RemoteBrowserSession> {
    return { id: "local-session", connectUrl: this.connectUrl, expiresAt: Date.now() + 3_600_000 };
  }
  async invalidate(): Promise<void> {}
  async close(): Promise<void> {}
}

async function localRemote(): Promise<{ browser: CdpBrowser; sessions: LocalSessions }> {
  const port = await freePort();
  const browser = await chromium.launch({ args: [`--remote-debugging-port=${port}`] });
  return { browser, sessions: new LocalSessions(`http://127.0.0.1:${port}`) };
}
