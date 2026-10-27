import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { expect, it } from "vitest";
import { BrowserbaseSessions, readBrowserbaseSettings } from "../src/browser/browserbase";
import { SandboxBrowser, type BrowserHost } from "../src/browser/sandbox-browser";
import type { ExecOutcome } from "../src/sandbox/runtime";

const settings = readBrowserbaseSettings(process.env);

/**
 * Runs only with real BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID set. The
 * daemon runs locally in a temp workspace and drives a real Browserbase session.
 */
it.skipIf(!settings.ok)(
  "drives a real Browserbase session through the sandbox daemon",
  async () => {
    if (!settings.ok) return;
    const root = await mkdtemp(join(tmpdir(), "mockbot-bb-live-"));
    const sessions = new BrowserbaseSessions(settings.settings);
    const browser = new SandboxBrowser(localHost(root), {
      paths: { node: process.execPath, nodePath: resolve(__dirname, "../node_modules") },
      install: false,
      sessions,
      port: 9530,
    });
    try {
      const opened = await browser.perform({
        action: "open",
        url: "https://example.com/",
        timeoutMs: 30_000,
        allowSubmit: false,
      });
      expect(opened).toMatchObject({ ok: true, title: "Example Domain" });
      const id = sessions.current?.id;
      const text = await browser.perform({
        action: "extract",
        selector: "body",
        timeoutMs: 15_000,
        allowSubmit: false,
      });
      expect(text).toMatchObject({ ok: true });
      expect(text.ok && text.text).toContain("documentation examples");
      expect(sessions.current?.id).toBe(id);
    } finally {
      await browser.close();
      await rm(root, { recursive: true, force: true });
    }
    expect(sessions.current).toBeNull();
  },
  120_000,
);

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
        child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
        child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
        const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
        child.on("close", (code) => {
          clearTimeout(timer);
          done({ stdout, stderr, exitCode: code, timedOut: false });
        });
      });
    },
  };
}
