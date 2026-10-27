import type { ExecOutcome } from "../sandbox/runtime";
import { BROWSERD_SOURCE } from "./browserd-source";
import { browserInstallCommand, browserInstallScript, type BrowserPaths } from "./install";
import {
  BROWSER_EXEC_MARGIN_MS,
  BROWSER_INSTALL_TIMEOUT_MS,
  BROWSER_START_TIMEOUT_MS,
} from "./limits";
import type { BrowseOutcome, BrowseStep, BrowserDriver } from "./types";

/** The two sandbox operations the browser needs. Paths are relative to the workspace. */
export type BrowserHost = {
  write(path: string, content: string): Promise<{ ok: true } | { ok: false; error: string }>;
  exec(command: string, timeoutMs: number, signal?: AbortSignal): Promise<ExecOutcome>;
};

export const DAEMON_PATH = ".mockbot/browserd.cjs";
export const INSTALL_PATH = ".mockbot/install-browser.sh";
export const DEFAULT_BROWSER_PORT = 9417;

/** Env prefix for Node and Playwright inside the sandbox. Shared with site-tool scripts. */
export function browserCommandPrefix(paths: BrowserPaths, port = DEFAULT_BROWSER_PORT): string {
  const pairs = [`NODE_PATH=${quote(paths.nodePath)}`, `MOCKBOT_BROWSER_PORT=${port}`];
  if (paths.browsersPath) pairs.push(`PLAYWRIGHT_BROWSERS_PATH=${quote(paths.browsersPath)}`);
  return pairs.join(" ");
}

/**
 * Drives the headless browser daemon inside a sandbox. Every action is one exec
 * of `node browserd.cjs send`, so the host never runs a browser itself.
 */
export class SandboxBrowser implements BrowserDriver {
  #installed: Promise<void> | null = null;

  constructor(
    private readonly host: BrowserHost,
    private readonly options: {
      paths: BrowserPaths;
      /** Install Node, Playwright, and Chromium on first use. Off when they are already there. */
      install: boolean;
      port?: number;
    },
  ) {}

  async perform(step: BrowseStep, signal?: AbortSignal): Promise<BrowseOutcome> {
    const ready = await this.ensureReady(signal);
    if (!ready.ok) return ready;
    return this.#send({ ...step, startTimeoutMs: BROWSER_START_TIMEOUT_MS }, signal);
  }

  /** Installs Playwright on first use. Site tools call this before running a saved script. */
  async ensureReady(signal?: AbortSignal): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      await this.#ensureInstalled(signal);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: errorText(error, "The sandbox browser could not be installed.") };
    }
  }

  /** Stops the daemon. Safe to call when it is not running. */
  async close(): Promise<void> {
    await this.#send({ action: "close", timeoutMs: 1_000, startTimeoutMs: 0 });
  }

  async #send(step: Record<string, unknown>, signal?: AbortSignal): Promise<BrowseOutcome> {
    const wrote = await this.host.write(DAEMON_PATH, BROWSERD_SOURCE);
    if (!wrote.ok) return { ok: false, error: wrote.error };
    const encoded = Buffer.from(JSON.stringify(step)).toString("base64");
    const timeoutMs =
      Number(step.timeoutMs) + Number(step.startTimeoutMs ?? 0) + BROWSER_EXEC_MARGIN_MS;
    const outcome = await this.host.exec(
      `${this.#env()} ${quote(this.options.paths.node)} ${DAEMON_PATH} send ${encoded}`,
      timeoutMs,
      signal,
    );
    if (outcome.timedOut) {
      return {
        ok: false,
        timedOut: true,
        error: `The browser action timed out after ${Math.round(Number(step.timeoutMs) / 1000)}s.`,
      };
    }
    return parseOutcome(outcome);
  }

  #env(): string {
    return browserCommandPrefix(this.options.paths, this.options.port ?? DEFAULT_BROWSER_PORT);
  }

  #ensureInstalled(signal?: AbortSignal): Promise<void> {
    if (!this.options.install) return Promise.resolve();
    if (!this.#installed) {
      this.#installed = this.#install(signal).catch((error: unknown) => {
        this.#installed = null;
        throw error;
      });
    }
    return this.#installed;
  }

  async #install(signal?: AbortSignal): Promise<void> {
    const wrote = await this.host.write(INSTALL_PATH, browserInstallScript());
    if (!wrote.ok) throw new Error(wrote.error);
    const outcome = await this.host.exec(
      browserInstallCommand(INSTALL_PATH),
      BROWSER_INSTALL_TIMEOUT_MS,
      signal,
    );
    if (outcome.timedOut) throw new Error("Installing the sandbox browser timed out.");
    if (outcome.exitCode !== 0) {
      const tail = `${outcome.stderr}\n${outcome.stdout}`.trim().slice(-500);
      throw new Error(`Installing the sandbox browser failed (exit ${outcome.exitCode}): ${tail}`);
    }
  }
}

function parseOutcome(outcome: ExecOutcome): BrowseOutcome {
  const line = outcome.stdout.trim().split("\n").at(-1) ?? "";
  try {
    const parsed = JSON.parse(line) as BrowseOutcome;
    if (parsed && typeof parsed === "object" && typeof parsed.ok === "boolean") return parsed;
  } catch {
    // Fall through to the exit-code message.
  }
  const detail = `${outcome.stderr}\n${outcome.stdout}`.trim().slice(-500) || "no output";
  return { ok: false, error: `The sandbox browser failed (exit ${outcome.exitCode}): ${detail}` };
}

function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
