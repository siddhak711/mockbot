import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { POST as postChat } from "../app/api/chat/route";
import { POST as postApproval } from "../app/api/tools/approvals/route";
import { PLAYWRIGHT_VERSION, browserInstallScript } from "../src/browser/install";
import { MAX_BROWSE_ACTIONS } from "../src/browser/limits";
import { SandboxBrowser, type BrowserHost } from "../src/browser/sandbox-browser";
import { browseNeedsApproval, browseTool, prepareBrowseArgs } from "../src/browser/tool";
import type { BrowseOutcome, BrowseStep, BrowserDriver } from "../src/browser/types";
import { resetAppContext, setAppContext } from "../src/context";
import type { LlmProvider } from "../src/llm";
import type { ExecOutcome } from "../src/sandbox/runtime";
import { SseParser } from "../src/sse";
import { ConversationStore } from "../src/store";
import { requiresApproval } from "../src/tools/approval";
import { createDefaultTools } from "../src/tools/builtins";
import type { ToolDefinition } from "../src/tools/types";
import type { LlmMessage, LlmStreamEvent } from "../src/types";
import packageJson from "../package.json";

const FIXTURES = resolve(__dirname, "fixtures/browse");
const REPO_MODULES = resolve(__dirname, "../node_modules");

let fixture: Server;
let baseUrl = "";
const posts: Array<{ path: string; body: string }> = [];

let workspace = "";
let browser: SandboxBrowser;

/**
 * Stands in for the Daytona sandbox: same write and exec contract, run on the
 * host in a temp workspace. The daemon, its protocol, and Chromium are the real ones.
 */
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
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  server.close();
  if (!address || typeof address === "string") throw new Error("No port");
  return address.port;
}

/** Counts actions that reached the sandbox browser. */
class CountingDriver implements BrowserDriver {
  readonly steps: BrowseStep[] = [];
  constructor(private readonly inner: BrowserDriver) {}
  perform(step: BrowseStep, signal?: AbortSignal): Promise<BrowseOutcome> {
    this.steps.push(step);
    return this.inner.perform(step, signal);
  }
}

beforeAll(async () => {
  fixture = createServer((req, res) => {
    if (req.method === "POST") {
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString()));
      req.on("end", () => {
        posts.push({ path: req.url ?? "", body });
        res.setHeader("Content-Type", "text/html");
        res.end("<!doctype html><title>Submitted</title><p id='done'>Order received</p>");
      });
      return;
    }
    const name = req.url === "/login.html" ? "login.html" : "index.html";
    readFile(join(FIXTURES, name)).then((html) => {
      res.setHeader("Content-Type", "text/html");
      res.end(html);
    });
  });
  fixture.listen(0, "127.0.0.1");
  await once(fixture, "listening");
  const address = fixture.address();
  if (!address || typeof address === "string") throw new Error("No fixture port");
  baseUrl = `http://127.0.0.1:${address.port}`;

  workspace = await mkdtemp(join(tmpdir(), "mockbot-browse-"));
  browser = new SandboxBrowser(localHost(workspace), {
    paths: { node: process.execPath, nodePath: REPO_MODULES },
    install: false,
    port: await freePort(),
  });
}, 30_000);

afterAll(async () => {
  await browser?.close();
  fixture?.close();
  if (workspace) await rm(workspace, { recursive: true, force: true });
});

afterEach(async () => {
  posts.length = 0;
  await resetAppContext();
});

function step(partial: Partial<BrowseStep> & Pick<BrowseStep, "action">): BrowseStep {
  return { timeoutMs: 10_000, allowSubmit: false, ...partial };
}

it("opens the fixture page, extracts a value, and returns a screenshot", async () => {
  const opened = await browser.perform(step({ action: "open", url: `${baseUrl}/` }));
  expect(opened).toMatchObject({ ok: true, title: "Fixture Store", status: 200 });

  const price = await browser.perform(step({ action: "extract", selector: "#price" }));
  expect(price).toMatchObject({ ok: true, text: "$42.17" });

  const shot = await browser.perform(step({ action: "screenshot" }));
  expect(shot.ok).toBe(true);
  if (!shot.ok || !shot.screenshot) throw new Error("Expected a screenshot");
  const png = Buffer.from(shot.screenshot.base64, "base64");
  expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  expect(png.readUInt32BE(16)).toBe(1024);
  expect(png.readUInt32BE(20)).toBe(640);
  expect(shot.screenshot.bytes).toBe(png.length);
  const saved = await readFile(join(workspace, shot.screenshot.path));
  expect(saved.equals(png)).toBe(true);
  if (process.env.BROWSE_SHOT_OUT) await writeFile(process.env.BROWSE_SHOT_OUT, png);
}, 30_000);

it("clicks and types on the page", async () => {
  await browser.perform(step({ action: "open", url: `${baseUrl}/` }));
  expect(await browser.perform(step({ action: "click", selector: "#reveal" }))).toMatchObject({
    ok: true,
  });
  expect(await browser.perform(step({ action: "extract", selector: "#secret" }))).toMatchObject({
    text: "revealed",
  });
  expect(
    await browser.perform(step({ action: "type", selector: "#note", text: "hello" })),
  ).toMatchObject({ ok: true });
}, 30_000);

it("stops an action at its timeout", async () => {
  await browser.perform(step({ action: "open", url: `${baseUrl}/` }));
  const started = Date.now();
  const missing = await browser.perform(
    step({ action: "click", selector: "#does-not-exist", timeoutMs: 500 }),
  );
  expect(Date.now() - started).toBeLessThan(5_000);
  expect(missing).toMatchObject({ ok: false, timedOut: true });
}, 30_000);

it("refuses form submits, login clicks, and password typing without approval", async () => {
  await browser.perform(step({ action: "open", url: `${baseUrl}/` }));
  const order = await browser.perform(step({ action: "click", selector: "#go" }));
  expect(order).toMatchObject({ ok: false, needsApproval: true });
  expect(posts).toEqual([]);

  await browser.perform(step({ action: "open", url: `${baseUrl}/login.html` }));
  expect(
    await browser.perform(step({ action: "type", selector: "#pass", text: "hunter2" })),
  ).toMatchObject({ ok: false, needsApproval: true });
  expect(await browser.perform(step({ action: "click", selector: "#continue" }))).toMatchObject({
    ok: false,
    needsApproval: true,
    error: "This click submits a login form.",
  });
  expect(posts).toEqual([]);

  const approved = await browser.perform(
    step({ action: "click", selector: "#continue", allowSubmit: true }),
  );
  expect(approved).toMatchObject({ ok: true, title: "Submitted" });
  expect(posts.map((post) => post.path)).toEqual(["/login"]);
}, 30_000);

it("validates arguments and routes confirm and submit selectors to approval", () => {
  expect(prepareBrowseArgs({ action: "open", url: "file:///etc/passwd" })).toEqual({
    error: "browse only opens http and https URLs.",
  });
  expect(prepareBrowseArgs({ action: "click" })).toEqual({
    error: "browse click requires a selector.",
  });
  expect(prepareBrowseArgs({ action: "fly" })).toHaveProperty("error");

  const tool = browseTool({ driver: () => null });
  expect(requiresApproval(tool, { action: "extract", selector: "#price" })).toBe(false);
  expect(requiresApproval(tool, { action: "click", selector: "#reveal" })).toBe(false);
  expect(requiresApproval(tool, { action: "click", selector: "#go", confirm: true })).toBe(true);
  expect(requiresApproval(tool, { action: "click", selector: "button[type=submit]" })).toBe(true);
  expect(browseNeedsApproval({ action: "type", selector: "#password", text: "x" })).toBe(true);
});

it("explains that browse is unavailable without a Daytona sandbox", async () => {
  const tool = browseTool({ driver: () => null, unavailable: "DAYTONA_API_KEY is not set" });
  const result = await tool.invoke({ action: "screenshot" }, {});
  expect(result).toEqual({ content: "DAYTONA_API_KEY is not set", isError: true });
});

it("pins the sandbox Playwright version to the one the tests run", () => {
  expect(packageJson.devDependencies["playwright-core"]).toBe(PLAYWRIGHT_VERSION);
  expect(browserInstallScript()).toContain(`playwright-core@${PLAYWRIGHT_VERSION}`);
});

type Call = { id: string; name: string; args: Record<string, unknown> };

/** A mock model that replays rounds of tool calls, or loops one round forever. */
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

async function contextWith(provider: LlmProvider, tool: ToolDefinition) {
  const store = await ConversationStore.open();
  const tools = createDefaultTools({});
  tools.register(tool);
  setAppContext({ store, provider, tools });
  return store;
}

function chat(message: string): Promise<Response> {
  return postChat(
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    }),
  );
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
): Promise<SseEvent[]> {
  const events: SseEvent[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) return events;
    for (const message of parser.push(decoder.decode(value, { stream: true }))) {
      events.push({
        event: message.event,
        data: JSON.parse(message.data) as Record<string, unknown>,
      });
    }
  }
}

it("halts a runaway browse loop at 20 actions", async () => {
  const driver = new CountingDriver(browser);
  const model = new ScriptedModel((round) =>
    [0, 1, 2, 3].map((slot) => ({
      id: `call_${round}_${slot}`,
      name: "browse",
      args:
        round === 0 && slot === 0
          ? { action: "open", url: `${baseUrl}/` }
          : { action: "extract", selector: "#price" },
    })),
  );
  await contextWith(model, browseTool({ driver: () => driver }));

  const { events } = await readEvents(await chat("Check the price forever"));
  const results = events.filter((event) => event.event === "tool_result");

  expect(driver.steps).toHaveLength(MAX_BROWSE_ACTIONS);
  expect(results).toHaveLength(MAX_BROWSE_ACTIONS + 4);
  expect(results.slice(0, MAX_BROWSE_ACTIONS).every((event) => event.data.status === "done")).toBe(
    true,
  );
  const refused = results.slice(MAX_BROWSE_ACTIONS);
  expect(refused.every((event) => event.data.status === "error")).toBe(true);
  expect(String(refused[0]?.data.output)).toContain("limit of 20 actions");
  // Six rounds of four calls: five ran 20 actions, the sixth was refused and ended the run.
  // The model was never asked for a seventh round, although the chat loop allows eight.
  expect(model.rounds).toBe(6);
  expect(events.at(-1)?.event).toBe("done");
}, 60_000);

it("asks the approval layer before a form submit reaches the page", async () => {
  const driver = new CountingDriver(browser);
  const model = new ScriptedModel((round) => {
    if (round === 0)
      return [{ id: "c0", name: "browse", args: { action: "open", url: `${baseUrl}/` } }];
    if (round === 1)
      return [{ id: "c1", name: "browse", args: { action: "click", selector: "#go" } }];
    if (round === 2) {
      return [
        { id: "c2", name: "browse", args: { action: "click", selector: "#go", confirm: true } },
      ];
    }
    return "Order placed.";
  });
  await contextWith(model, browseTool({ driver: () => driver }));

  const first = await readEvents(await chat("Buy one widget"), "approval_required");
  const results = first.events.filter((event) => event.event === "tool_result");
  expect(String(results[1]?.data.output)).toContain("This click submits a form.");
  expect(String(results[1]?.data.output)).toContain("Nothing was submitted");
  const approval = first.events.find((event) => event.event === "approval_required");
  expect(approval?.data).toMatchObject({ id: "c2", name: "browse" });
  // The approval card is up and the third call has not reached the browser.
  expect(driver.steps).toHaveLength(2);
  expect(posts).toEqual([]);

  const decision = await postApproval(
    new Request("http://localhost/api/tools/approvals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "c2", decision: "approve" }),
    }),
  );
  expect(decision.status).toBe(200);
  const rest = await drain(first.reader, first.parser, first.decoder);
  const submitted = rest.find((event) => event.event === "tool_result" && event.data.id === "c2");
  expect(submitted?.data.status).toBe("done");
  expect(String(submitted?.data.output)).toContain("Submitted");
  expect(driver.steps.at(-1)).toMatchObject({ action: "click", allowSubmit: true });
  expect(posts.map((post) => post.path)).toEqual(["/order"]);
}, 60_000);

it("leaves the form unsubmitted when the user denies", async () => {
  const driver = new CountingDriver(browser);
  const model = new ScriptedModel((round) => {
    if (round === 0)
      return [{ id: "d0", name: "browse", args: { action: "open", url: `${baseUrl}/` } }];
    if (round === 1) {
      return [
        { id: "d1", name: "browse", args: { action: "click", selector: "#go", confirm: true } },
      ];
    }
    return "Okay, I did not place the order.";
  });
  await contextWith(model, browseTool({ driver: () => driver }));

  const first = await readEvents(await chat("Buy one widget"), "approval_required");
  await postApproval(
    new Request("http://localhost/api/tools/approvals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "d1", decision: "deny" }),
    }),
  );
  await drain(first.reader, first.parser, first.decoder);
  expect(driver.steps.map((item) => item.action)).toEqual(["open"]);
  expect(posts).toEqual([]);
}, 60_000);
