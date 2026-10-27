import { randomUUID } from "node:crypto";
import type { BrowserSessionSource } from "../browser/browserbase";
import { browserCommandPrefix, type BrowserHost } from "../browser/sandbox-browser";
import type { BrowserPaths } from "../browser/install";
import { SITE_TOOL_RUN_TIMEOUT_MS, type ScriptRunResult } from "./types";

/**
 * Runs a saved script in the sandbox. The script connects over CDP to a remote
 * browser session acquired here for this run and released when it ends.
 */
export async function runPlaywrightScript(options: {
  host: BrowserHost;
  paths: BrowserPaths;
  sessions: BrowserSessionSource;
  script: string;
  args: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
  allowSubmit?: boolean;
}): Promise<ScriptRunResult> {
  try {
    return await runWithSession(options);
  } finally {
    await options.sessions.close().catch(() => undefined);
  }
}

async function runWithSession(options: {
  host: BrowserHost;
  paths: BrowserPaths;
  sessions: BrowserSessionSource;
  script: string;
  args: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
  allowSubmit?: boolean;
}): Promise<ScriptRunResult> {
  let connectUrl: string;
  try {
    connectUrl = (await options.sessions.acquire(options.signal)).connectUrl;
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : "";
    return { ok: false, error: message || "The remote browser session did not start." };
  }
  const scriptPath = `.mockbot/site-tools/run-${randomUUID()}.cjs`;
  const wrote = await options.host.write(scriptPath, options.script);
  if (!wrote.ok) return { ok: false, error: wrote.error };
  const encoded = Buffer.from(JSON.stringify(options.args)).toString("base64");
  const allow = options.allowSubmit ? "1" : "0";
  const command = `${browserCommandPrefix(options.paths)} ${quote(options.paths.node)} ${quote(scriptPath)} ${quote(encoded)} ${quote(allow)} ${quote(connectUrl)}`;
  const timeoutMs = options.timeoutMs ?? SITE_TOOL_RUN_TIMEOUT_MS;
  const outcome = await options.host.exec(command, timeoutMs, options.signal);
  if (outcome.timedOut) {
    return {
      ok: false,
      error: `The site tool script timed out after ${Math.round(timeoutMs / 1000)}s.`,
    };
  }
  const line = outcome.stdout.trim().split("\n").at(-1) ?? "";
  try {
    const parsed = JSON.parse(line) as { ok?: unknown; result?: unknown; error?: unknown };
    if (parsed && parsed.ok === true) return { ok: true, result: parsed.result ?? null };
    if (parsed && parsed.ok === false) {
      const error =
        typeof parsed.error === "string" ? parsed.error : "The site tool script failed.";
      return { ok: false, error };
    }
  } catch {
    // Fall through to the exit-code message.
  }
  const detail = `${outcome.stderr}\n${outcome.stdout}`.trim().slice(-500) || "no output";
  return { ok: false, error: `The site tool script failed (exit ${outcome.exitCode}): ${detail}` };
}

function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
