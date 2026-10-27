import { throwIfAborted, withSignal } from "../sandbox/abort";
import type { ExecOutcome } from "../sandbox/runtime";
import { BROWSERD_SOURCE } from "./browserd-source";
import { browserInstallCommand, browserInstallScript, type BrowserPaths } from "./install";
import {
  BROWSER_EXEC_MARGIN_MS,
  BROWSER_INSTALL_TIMEOUT_MS,
  BROWSER_START_TIMEOUT_MS,
} from "./limits";
import type { BrowseOutcome, BrowseStep, BrowserDriver } from "./types";

/** The sandbox operations the browser needs. Paths are relative to the workspace. */
export type BrowserHost = {
  write(path: string, content: string): Promise<{ ok: true } | { ok: false; error: string }>;
  exec(command: string, timeoutMs: number, signal?: AbortSignal): Promise<ExecOutcome>;
  /**
   * Create or restore the sandbox before its id is read. The stored id stays
   * stale until this runs and a replacement is created.
   */
  prepare?: (signal?: AbortSignal) => Promise<void>;
  /**
   * Daytona sandbox id for this host. A new id means the machine was replaced
   * and a previous install must not be reused.
   */
  sandboxId?: () => Promise<string | null>;
};

export const DAEMON_PATH = ".mockbot/browserd.cjs";
export const INSTALL_PATH = ".mockbot/install-browser.sh";
export const DEFAULT_BROWSER_PORT = 9417;

/**
 * Drives the headless browser daemon inside a sandbox. Every action is one exec
 * of `node browserd.cjs send`, so the host never runs a browser itself.
 */
export class SandboxBrowser implements BrowserDriver {
  #installed: Promise<void> | null = null;
  /** Sandbox id the cached install belongs to. Null when the host has no id. */
  #installedFor: string | null = null;
  /** Serializes install decisions so two browse calls share one installer. */
  #gate: Promise<void> = Promise.resolve();

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
    try {
      await this.#ensureInstalled(signal);
    } catch (error) {
      return { ok: false, error: errorText(error, "The sandbox browser could not be installed.") };
    }
    return this.#send({ ...step, startTimeoutMs: BROWSER_START_TIMEOUT_MS }, signal);
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
    const { paths, port } = this.options;
    const pairs = [
      `NODE_PATH=${quote(paths.nodePath)}`,
      `MOCKBOT_BROWSER_PORT=${port ?? DEFAULT_BROWSER_PORT}`,
    ];
    if (paths.browsersPath) pairs.push(`PLAYWRIGHT_BROWSERS_PATH=${quote(paths.browsersPath)}`);
    return pairs.join(" ");
  }

  /**
   * One installer at a time. Aborting the caller stops the wait only.
   * Daytona leaves the remote command running after the local exec rejects, so
   * forgetting this promise would start a second installer over the first.
   * A changed sandbox id drops that cache: the new machine does not have the install.
   */
  #ensureInstalled(signal?: AbortSignal): Promise<void> {
    if (!this.options.install) return Promise.resolve();
    throwIfAborted(signal);
    const run = this.#gate.then(() => this.#syncInstall(signal));
    this.#gate = run.then(
      () => undefined,
      () => undefined,
    );
    return withSignal(run, signal);
  }

  async #sandboxId(): Promise<string | null> {
    if (!this.host.sandboxId) return null;
    const id = await this.host.sandboxId();
    return id || null;
  }

  async #syncInstall(signal?: AbortSignal): Promise<void> {
    // The stored id still names the dead sandbox until prepare creates the replacement.
    if (this.host.prepare) await this.host.prepare(signal);
    const sandboxId = await this.#sandboxId();
    if (this.#installed && this.#installedFor === sandboxId) {
      await this.#installed;
      return;
    }
    const slot = this.#install().then(async () => {
      this.#installedFor = (await this.#sandboxId()) ?? sandboxId;
    });
    const tracked = slot.catch((error: unknown) => {
      if (this.#installed === tracked) {
        this.#installed = null;
        this.#installedFor = null;
      }
      throw error;
    });
    this.#installed = tracked;
    await tracked;
  }

  async #install(): Promise<void> {
    const wrote = await this.host.write(INSTALL_PATH, browserInstallScript());
    if (!wrote.ok) throw new Error(wrote.error);
    const outcome = await this.host.exec(
      browserInstallCommand(INSTALL_PATH),
      BROWSER_INSTALL_TIMEOUT_MS,
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
