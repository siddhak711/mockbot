import { afterEach, expect, it, vi } from "vitest";
import {
  BROWSERBASE_API,
  BROWSERBASE_SESSION_SECONDS,
  BrowserbaseSessions,
  readBrowserbaseSettings,
} from "../src/browser/browserbase";
import { sandboxBrowseTool } from "../src/browser/open";
import { SandboxBrowser, type BrowserHost } from "../src/browser/sandbox-browser";
import type { ComputerSupervisor } from "../src/sandbox/supervisor";
import type { ExecOutcome } from "../src/sandbox/runtime";

const ENV = { BROWSERBASE_API_KEY: "bb_live_secret", BROWSERBASE_PROJECT_ID: "proj-1" };

afterEach(() => {
  vi.useRealTimers();
});

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };

/** Stands in for the Browserbase API. Each create returns a new session. */
function fakeBrowserbase(options: { status?: number; expiresInMs?: number } = {}) {
  const calls: Call[] = [];
  let created = 0;
  const fetch = async (url: string, init?: RequestInit) => {
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    if (url === `${BROWSERBASE_API}/sessions`) {
      if (options.status && options.status !== 201) {
        return new Response("limit", { status: options.status });
      }
      created += 1;
      const id = `bb-${created}`;
      return Response.json(
        {
          id,
          connectUrl: `wss://connect.browserbase.com?signingKey=sk-${id}`,
          expiresAt: new Date(Date.now() + (options.expiresInMs ?? 900_000)).toISOString(),
        },
        { status: 201 },
      );
    }
    return Response.json({ status: "COMPLETED" });
  };
  const creates = () => calls.filter((call) => call.url === `${BROWSERBASE_API}/sessions`);
  const releases = () =>
    calls.filter((call) => call.url !== `${BROWSERBASE_API}/sessions`).map((call) => call.url);
  return { fetch, calls, creates, releases };
}

/** A sandbox host that records what reaches the sandbox and answers like the daemon. */
function recordingHost() {
  const commands: string[] = [];
  const writes: string[] = [];
  const steps: Array<Record<string, unknown>> = [];
  const host: BrowserHost = {
    async write(_path, content) {
      writes.push(content);
      return { ok: true };
    },
    async exec(command): Promise<ExecOutcome> {
      commands.push(command);
      const encoded = / send (\S+)$/.exec(command)?.[1];
      if (encoded) steps.push(JSON.parse(Buffer.from(encoded, "base64").toString("utf8")));
      return {
        stdout: `${JSON.stringify({ ok: true, url: "https://example.com/", title: "Example" })}\n`,
        stderr: "",
        exitCode: 0,
        timedOut: false,
      };
    },
  };
  return { host, commands, writes, steps };
}

function daytonaWith(host: BrowserHost): ComputerSupervisor {
  return { browserHost: () => host } as unknown as ComputerSupervisor;
}

it("creates the Browserbase session from env and hands only its connect URL to the sandbox", async () => {
  const api = fakeBrowserbase();
  const sandbox = recordingHost();
  const tool = sandboxBrowseTool(daytonaWith(sandbox.host), ENV, undefined, { fetch: api.fetch });

  const result = await tool.invoke(
    { action: "open", url: "https://example.com" },
    { agentId: "agent-a" },
  );
  expect(result.isError).toBeFalsy();

  const [create] = api.creates();
  expect(create?.method).toBe("POST");
  expect(create?.headers["X-BB-API-Key"]).toBe("bb_live_secret");
  expect(create?.body).toEqual({ projectId: "proj-1", timeout: BROWSERBASE_SESSION_SECONDS });

  const open = sandbox.steps.find((step) => step.action === "open");
  expect(open?.session).toEqual({
    id: "bb-1",
    connectUrl: "wss://connect.browserbase.com?signingKey=sk-bb-1",
  });
  // The API key never reaches the sandbox: not in a command, its env, or an uploaded file.
  for (const text of [...sandbox.commands, ...sandbox.writes]) {
    expect(text).not.toContain("bb_live_secret");
    expect(text).not.toContain("BROWSERBASE_API_KEY");
  }
});

it("fails visibly when a Browserbase key is missing, with no session and no fallback", async () => {
  for (const env of [
    {},
    { BROWSERBASE_API_KEY: "bb_live_secret" },
    { BROWSERBASE_PROJECT_ID: "proj-1" },
  ]) {
    const api = fakeBrowserbase();
    const sandbox = recordingHost();
    const tool = sandboxBrowseTool(daytonaWith(sandbox.host), env, undefined, { fetch: api.fetch });
    const result = await tool.invoke({ action: "open", url: "https://example.com" }, {});
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Browserbase isn't connected");
    expect(result.content).not.toMatch(/mock/i);
    expect(api.calls).toHaveLength(0);
    expect(sandbox.commands).toHaveLength(0);
  }
  expect(readBrowserbaseSettings({})).toEqual({
    ok: false,
    error:
      "Browserbase isn't connected: BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID are not set, so browse cannot open a browser.",
  });
});

it("reuses one session across actions, replaces it near expiry, and releases it on close", async () => {
  let now = Date.parse("2026-10-27T12:00:00Z");
  vi.useFakeTimers({ now, toFake: ["Date"] });
  const api = fakeBrowserbase();
  const sessions = new BrowserbaseSessions(readSettings(), { fetch: api.fetch, now: () => now });

  const first = await sessions.acquire();
  const again = await sessions.acquire();
  expect(again.id).toBe(first.id);
  expect(api.creates()).toHaveLength(1);

  // Two overlapping first actions share one create.
  const fresh = new BrowserbaseSessions(readSettings(), { fetch: api.fetch, now: () => now });
  const [a, b] = await Promise.all([fresh.acquire(), fresh.acquire()]);
  expect(a.id).toBe(b.id);
  expect(api.creates()).toHaveLength(2);
  await fresh.close();

  // Within a minute of the 15-minute limit, the session is released and replaced.
  now += 14.5 * 60_000;
  const replaced = await sessions.acquire();
  expect(replaced.id).not.toBe(first.id);
  expect(api.releases()).toContain(`${BROWSERBASE_API}/sessions/${first.id}`);

  // A session that ended early is dropped, then the next action gets a new one.
  await sessions.invalidate(replaced.id);
  expect(api.releases()).toContain(`${BROWSERBASE_API}/sessions/${replaced.id}`);
  const next = await sessions.acquire();
  expect(next.id).not.toBe(replaced.id);

  await sessions.close();
  const release = api.calls.at(-1);
  expect(release?.url).toBe(`${BROWSERBASE_API}/sessions/${next.id}`);
  expect(release?.body).toEqual({ projectId: "proj-1", status: "REQUEST_RELEASE" });
  expect(sessions.current).toBeNull();
});

it("releases the idle session so it does not hold a concurrency slot", async () => {
  vi.useFakeTimers();
  const api = fakeBrowserbase();
  const sessions = new BrowserbaseSessions(readSettings(), { fetch: api.fetch, idleMs: 1_000 });
  const session = await sessions.acquire();
  await vi.advanceTimersByTimeAsync(1_100);
  expect(api.releases()).toEqual([`${BROWSERBASE_API}/sessions/${session.id}`]);
  expect(sessions.current).toBeNull();
});

it("explains the free plan's concurrency limit instead of retrying blindly", async () => {
  const api = fakeBrowserbase({ status: 429 });
  const sandbox = recordingHost();
  const tool = sandboxBrowseTool(daytonaWith(sandbox.host), ENV, undefined, { fetch: api.fetch });
  const result = await tool.invoke({ action: "open", url: "https://example.com" }, {});
  expect(result.isError).toBe(true);
  expect(result.content).toContain("limit of concurrent browser sessions");
  expect(sandbox.steps).toHaveLength(0);
});

it("replaces a session that ended mid-run and releases the session on abort", async () => {
  const api = fakeBrowserbase();
  const steps: Array<{ action: unknown; session?: { id: string } }> = [];
  let endNext = true;
  const host: BrowserHost = {
    write: async () => ({ ok: true }),
    async exec(command) {
      const encoded = / send (\S+)$/.exec(command)?.[1] ?? "";
      const step = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
      steps.push(step);
      const ended = endNext && step.action === "open";
      endNext = false;
      const body = ended
        ? { ok: false, error: "The remote browser session ended: closed", sessionEnded: true }
        : { ok: true };
      return { stdout: JSON.stringify(body), stderr: "", exitCode: 0, timedOut: false };
    },
  };
  const sessions = new BrowserbaseSessions(readSettings(), { fetch: api.fetch });
  const browser = new SandboxBrowser(host, {
    paths: { node: "node", nodePath: "/modules" },
    install: false,
    sessions,
  });
  const step = { action: "open" as const, url: "https://example.com", timeoutMs: 1_000 };
  const outcome = await browser.perform({ ...step, allowSubmit: false });
  expect(outcome.ok).toBe(true);
  expect(steps.map((item) => item.session?.id)).toEqual(["bb-1", "bb-2"]);
  expect(api.releases()).toEqual([`${BROWSERBASE_API}/sessions/bb-1`]);

  const controller = new AbortController();
  controller.abort();
  await browser.perform({ ...step, allowSubmit: false }, controller.signal);
  expect(steps.at(-1)?.action).toBe("close");
  expect(api.releases()).toContain(`${BROWSERBASE_API}/sessions/bb-2`);
  expect(sessions.current).toBeNull();
});

function readSettings() {
  const read = readBrowserbaseSettings(ENV);
  if (!read.ok) throw new Error(read.error);
  return read.settings;
}
