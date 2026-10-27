import { execFile, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { BROWSERD_SOURCE } from "../src/browser/browserd-source";
import {
  INSTALL_COMPLETE_NAME,
  PLAYWRIGHT_VERSION,
  browserInstallReadyCommand,
  browserInstallScript,
} from "../src/browser/install";
import { SandboxBrowser, type BrowserHost } from "../src/browser/sandbox-browser";
import type { ExecOutcome } from "../src/sandbox/runtime";
import type { BrowseStep } from "../src/browser/types";

const children: ChildProcess[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const child of children) await stopChild(child);
  for (const root of roots) await killDaemons(root);
  for (const root of roots) await rm(root, { recursive: true, force: true });
  children.length = 0;
  roots.length = 0;
});

const openStep = (): BrowseStep => ({
  action: "open",
  url: "http://127.0.0.1/",
  timeoutMs: 1_000,
  allowSubmit: false,
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 8_000) {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out");
    await delay(20);
  }
}

function shellOk(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("sh", ["-c", command], (error) => resolve(!error));
  });
}

async function installTree(
  dir: string,
  options: { stamp?: string; binary?: boolean },
): Promise<void> {
  await mkdir(join(dir, "node/bin"), { recursive: true });
  await mkdir(join(dir, "lib/node_modules/playwright-core"), { recursive: true });
  await mkdir(join(dir, "browsers/partial"), { recursive: true });
  await writeFile(join(dir, "node/bin/node"), "");
  await chmod(join(dir, "node/bin/node"), 0o755);
  await writeFile(join(dir, "lib/node_modules/playwright-core/package.json"), "{}");
  if (options.binary) {
    await writeFile(join(dir, "browsers/partial/chrome-headless-shell"), "");
  }
  if (options.stamp !== undefined) {
    await writeFile(join(dir, INSTALL_COMPLETE_NAME), options.stamp);
  }
}

function hostTrackingInstalls(
  onInstall: (signal: AbortSignal | undefined) => Promise<ExecOutcome>,
): {
  host: BrowserHost;
  installs: () => number;
} {
  let installs = 0;
  const host: BrowserHost = {
    async write() {
      return { ok: true };
    },
    exec(command, _timeoutMs, signal) {
      if (!command.includes("install-browser")) {
        return Promise.resolve({
          stdout: `${JSON.stringify({ ok: true })}\n`,
          stderr: "",
          exitCode: 0,
          timedOut: false,
        });
      }
      installs += 1;
      return onInstall(signal);
    },
  };
  return { host, installs: () => installs };
}

function browserWith(host: BrowserHost): SandboxBrowser {
  return new SandboxBrowser(host, {
    paths: { node: "node", nodePath: "/modules" },
    install: true,
  });
}

it("does not start a second installer when the first install is aborted", async () => {
  let finishInstall: (outcome: ExecOutcome) => void = () => {};
  const installResult = new Promise<ExecOutcome>((resolve) => {
    finishInstall = resolve;
  });
  const tracked = hostTrackingInstalls((signal) => {
    expect(signal).toBeUndefined();
    return installResult;
  });
  const browser = browserWith(tracked.host);
  const controller = new AbortController();
  const first = browser.perform(openStep(), controller.signal);
  await waitFor(() => tracked.installs() === 1);
  controller.abort();
  await expect(first).resolves.toMatchObject({
    ok: false,
    error: "The operation was aborted",
  });

  const second = browser.perform(openStep());
  await delay(50);
  expect(tracked.installs()).toBe(1);
  finishInstall({ stdout: "", stderr: "", exitCode: 0, timedOut: false });
  await expect(second).resolves.toMatchObject({ ok: true });
  expect(tracked.installs()).toBe(1);
});

it("runs one installer for overlapping browse calls", async () => {
  let finishInstall: (outcome: ExecOutcome) => void = () => {};
  const installResult = new Promise<ExecOutcome>((resolve) => {
    finishInstall = resolve;
  });
  const tracked = hostTrackingInstalls(() => installResult);
  const browser = browserWith(tracked.host);
  const first = browser.perform(openStep());
  const second = browser.perform(openStep());
  await waitFor(() => tracked.installs() === 1);
  await delay(30);
  expect(tracked.installs()).toBe(1);
  finishInstall({ stdout: "", stderr: "", exitCode: 0, timedOut: false });
  await expect(Promise.all([first, second])).resolves.toEqual([
    expect.objectContaining({ ok: true }),
    expect.objectContaining({ ok: true }),
  ]);
  expect(tracked.installs()).toBe(1);
});

it("reinstalls using the sandbox id resolved after replacement", async () => {
  let stored = "sandbox-old";
  let resolved = "sandbox-old";
  const reads: string[] = [];
  const tracked = hostTrackingInstalls(async () => ({
    stdout: "",
    stderr: "",
    exitCode: 0,
    timedOut: false,
  }));
  tracked.host.prepare = async () => {
    stored = resolved;
  };
  tracked.host.sandboxId = async () => {
    reads.push(stored);
    return stored;
  };
  const browser = browserWith(tracked.host);
  await expect(browser.perform(openStep())).resolves.toMatchObject({ ok: true });
  expect(tracked.installs()).toBe(1);

  // The store still names the dead sandbox until prepare creates the replacement.
  resolved = "sandbox-new";
  const before = reads.length;
  await expect(browser.perform(openStep())).resolves.toMatchObject({ ok: true });
  expect(tracked.installs()).toBe(2);
  expect(reads.slice(before)).toContain("sandbox-new");
  expect(reads.slice(before)).not.toContain("sandbox-old");
});

it("reinstalls when the sandbox id changes", async () => {
  let sandboxId = "sandbox-old";
  const tracked = hostTrackingInstalls(async () => ({
    stdout: "",
    stderr: "",
    exitCode: 0,
    timedOut: false,
  }));
  tracked.host.sandboxId = async () => sandboxId;
  const browser = browserWith(tracked.host);
  await expect(browser.perform(openStep())).resolves.toMatchObject({ ok: true });
  await expect(browser.perform(openStep())).resolves.toMatchObject({ ok: true });
  expect(tracked.installs()).toBe(1);

  sandboxId = "sandbox-new";
  await expect(browser.perform(openStep())).resolves.toMatchObject({ ok: true });
  expect(tracked.installs()).toBe(2);
});

it("starts another installer only after the in-flight install has failed", async () => {
  const tracked = hostTrackingInstalls(async () => ({
    stdout: "",
    stderr: "boom",
    exitCode: 1,
    timedOut: false,
  }));
  const browser = browserWith(tracked.host);
  expect((await browser.perform(openStep())).ok).toBe(false);
  expect((await browser.perform(openStep())).ok).toBe(false);
  expect(tracked.installs()).toBe(2);
});

it("writes the install stamp only after Chromium install succeeds", () => {
  const script = browserInstallScript();
  expect(script).not.toContain('[ -d "$DIR/browsers" ]');
  const installAt = script.indexOf("install --with-deps --only-shell chromium");
  const clearAt = script.indexOf(`rm -f "$DIR/${INSTALL_COMPLETE_NAME}"`);
  const stampAt = script.lastIndexOf(`> "$DIR/${INSTALL_COMPLETE_NAME}"`);
  const binaryAt = script.indexOf("Chromium install did not finish");
  expect(clearAt).toBeGreaterThan(-1);
  expect(installAt).toBeGreaterThan(clearAt);
  expect(binaryAt).toBeGreaterThan(installAt);
  expect(stampAt).toBeGreaterThan(binaryAt);
  expect(script).toContain(PLAYWRIGHT_VERSION);
});

it("does not treat a partial browser directory as a finished install", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mockbot-install-"));
  roots.push(dir);
  const ready = () => shellOk(browserInstallReadyCommand(dir));

  await installTree(dir, {});
  expect(await ready()).toBe(false);

  await installTree(dir, { stamp: `${PLAYWRIGHT_VERSION}\n` });
  expect(await ready()).toBe(false);

  await installTree(dir, { binary: true, stamp: "0.0.0\n" });
  expect(await ready()).toBe(false);

  await installTree(dir, { binary: true, stamp: `${PLAYWRIGHT_VERSION}\n` });
  expect(await ready()).toBe(true);
});

const FAKE_PLAYWRIGHT = `const fs = require("fs");
function record(line) {
  fs.appendFileSync(process.env.BROWSER_LAUNCH_LOG, line + "\\n");
}
module.exports = {
  chromium: {
    async launch() {
      record("launch");
      await new Promise((resolve) => setTimeout(resolve, 300));
      return {
        async close() {
          record("close");
        },
        async newContext() {
          return {
            async newPage() {
              return {
                setDefaultTimeout() {},
                setDefaultNavigationTimeout() {},
                url() { return "about:blank"; },
                async title() { return ""; },
              };
            },
          };
        },
      };
    },
  },
};
`;

type DaemonProc = {
  child: ChildProcess;
  output: () => { stdout: string; stderr: string };
  exited: () => Promise<number | null>;
};

async function daemonFixture() {
  const root = await mkdtemp(join(tmpdir(), "mockbot-browserd-"));
  roots.push(root);
  const modules = join(root, "modules");
  await mkdir(join(modules, "playwright-core"), { recursive: true });
  await writeFile(
    join(modules, "playwright-core", "package.json"),
    JSON.stringify({ name: "playwright-core", main: "index.js" }),
  );
  await writeFile(join(modules, "playwright-core", "index.js"), FAKE_PLAYWRIGHT);
  const script = join(root, "browserd.cjs");
  await writeFile(script, BROWSERD_SOURCE);
  await new Promise<void>((resolve, reject) => {
    execFile(process.execPath, ["--check", script], (error) => (error ? reject(error) : resolve()));
  });
  const log = join(root, "launches.log");
  await writeFile(log, "");
  const port = await freePort();
  const env = {
    ...process.env,
    NODE_PATH: modules,
    MOCKBOT_BROWSER_PORT: String(port),
    BROWSER_LAUNCH_LOG: log,
  };
  return {
    root,
    port,
    spawn(args: string[]): DaemonProc {
      const child = spawn(process.execPath, [script, ...args], {
        cwd: root,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      children.push(child);
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => (stdout += chunk));
      child.stderr.on("data", (chunk: string) => (stderr += chunk));
      return {
        child,
        output: () => ({ stdout, stderr }),
        exited: () =>
          new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
              reject(new Error(`daemon timed out\nstdout: ${stdout}\nstderr: ${stderr}`));
            }, 8_000);
            child.once("exit", (code) => {
              clearTimeout(timer);
              resolve(code);
            });
          }),
      };
    },
    events: async () => (await readFile(log, "utf8")).split("\n").filter(Boolean),
  };
}

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  server.close();
  await once(server, "close");
  if (!address || typeof address === "string") throw new Error("No port");
  return address.port;
}

function ping(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path: "/ping", method: "GET", timeout: 500 },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      },
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

async function stopChild(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGKILL");
  await once(child, "exit").catch(() => undefined);
}

async function killDaemons(root: string) {
  const script = join(root, "browserd.cjs");
  await new Promise<void>((resolve) => {
    execFile("ps", ["-eo", "pid,args"], (error, stdout) => {
      if (!error) {
        for (const line of String(stdout).split("\n")) {
          if (!line.includes(script)) continue;
          const pid = Number(line.trim().split(/\s+/)[0]);
          if (pid > 0 && pid !== process.pid) {
            try {
              process.kill(pid, "SIGKILL");
            } catch {
              // Already gone.
            }
          }
        }
      }
      resolve();
    });
  });
}

it("starts one Chromium when two first actions overlap", async () => {
  const ctx = await daemonFixture();
  const step = Buffer.from(
    JSON.stringify({ action: "noop", timeoutMs: 1_000, startTimeoutMs: 5_000 }),
  ).toString("base64");
  const first = ctx.spawn(["send", step]);
  const second = ctx.spawn(["send", step]);
  const [codeA, codeB] = await Promise.all([first.exited(), second.exited()]);
  expect({ code: codeA, ...first.output() }).toMatchObject({ code: 0 });
  expect({ code: codeB, ...second.output() }).toMatchObject({ code: 0 });
  expect(first.output().stdout).toContain("Unknown browser action.");
  expect(second.output().stdout).toContain("Unknown browser action.");
  expect(await ctx.events()).toEqual(["launch"]);
  expect(await ping(ctx.port)).toBe(true);
});

it("does not launch a second Chromium while the daemon lock is held", async () => {
  const ctx = await daemonFixture();
  const first = ctx.spawn(["serve"]);
  await waitFor(() => ping(ctx.port));
  const second = ctx.spawn(["serve"]);
  expect(await second.exited()).toBe(0);
  expect(await ctx.events()).toEqual(["launch"]);
  expect(first.child.exitCode).toBeNull();
});

it("replaces a stale daemon lock left by a dead process", async () => {
  const ctx = await daemonFixture();
  await mkdir(join(ctx.root, "browserd.lock"));
  await writeFile(join(ctx.root, "browserd.lock", "pid"), "999999");
  const child = ctx.spawn(["serve"]);
  await waitFor(() => ping(ctx.port));
  expect(await ctx.events()).toEqual(["launch"]);
  expect(child.child.exitCode).toBeNull();
});

it("closes Chromium when the daemon cannot bind its port", async () => {
  const ctx = await daemonFixture();
  const blocker: Server = createServer();
  blocker.listen(ctx.port, "127.0.0.1");
  await once(blocker, "listening");
  try {
    const child = ctx.spawn(["serve"]);
    const code = await child.exited();
    expect({ code, ...child.output() }).toMatchObject({ code: 1 });
    expect(await ctx.events()).toEqual(["launch", "close"]);
  } finally {
    blocker.close();
  }
});
