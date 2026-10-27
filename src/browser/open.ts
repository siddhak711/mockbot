import type { ComputerSupervisor } from "../sandbox/supervisor";
import { DEFAULT_AGENT_ID } from "../sandbox/limits";
import { sandboxOwnerId } from "../sandbox/owner";
import {
  BrowserbaseSessions,
  readBrowserbaseSettings,
  type BrowserSessionSource,
} from "./browserbase";
import { SANDBOX_BROWSER_PATHS } from "./install";
import { browseTimeoutMs } from "./limits";
import { SandboxBrowser, type BrowserHost } from "./sandbox-browser";
import { browseTool } from "./tool";
import type { BrowserDriver } from "./types";
import type { ToolDefinition } from "../tools/types";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** A sandbox browser, or one that fails every action with a visible reason. */
export type OwnedBrowser = BrowserDriver & {
  ensureReady?(signal?: AbortSignal): Promise<{ ok: true } | { ok: false; error: string }>;
};

/**
 * One sandbox browser per (user, agent) owner, shared by the browse tool and
 * site tools so both drive the same daemon in that owner's sandbox. Each
 * browser holds its own Browserbase session.
 */
export class SandboxBrowsers {
  readonly #browsers = new Map<string, SandboxBrowser>();
  readonly #settings: ReturnType<typeof readBrowserbaseSettings>;

  constructor(
    private readonly sandbox: ComputerSupervisor,
    env: Record<string, string | undefined>,
    private readonly options: { fetch?: FetchLike } = {},
  ) {
    this.#settings = readBrowserbaseSettings(env);
  }

  /** The owner's sandbox, or null when it cannot run a browser (the mock computer). */
  host(owner: string): BrowserHost | null {
    return this.sandbox.browserHost(owner);
  }

  driver(owner: string): OwnedBrowser | null {
    const existing = this.#browsers.get(owner);
    if (existing) return existing;
    const host = this.host(owner);
    if (!host) return null;
    if (!this.#settings.ok) return failing(this.#settings.error);
    const browser = new SandboxBrowser(host, {
      paths: SANDBOX_BROWSER_PATHS,
      install: true,
      sessions: new BrowserbaseSessions(this.#settings.settings, { fetch: this.options.fetch }),
    });
    this.#browsers.set(owner, browser);
    return browser;
  }

  /** A fresh remote session source for one script run, closed by the caller. */
  scriptSessions(): BrowserSessionSource | { error: string } {
    if (!this.#settings.ok) return { error: this.#settings.error };
    return new BrowserbaseSessions(this.#settings.settings, { fetch: this.options.fetch });
  }
}

const shared = new WeakMap<ComputerSupervisor, SandboxBrowsers>();

/** The app's shared browsers for this sandbox. A custom fetch gets its own set. */
export function sandboxBrowsers(
  sandbox: ComputerSupervisor,
  env: Record<string, string | undefined>,
  options: { fetch?: FetchLike } = {},
): SandboxBrowsers {
  if (options.fetch) return new SandboxBrowsers(sandbox, env, options);
  const existing = shared.get(sandbox);
  if (existing) return existing;
  const created = new SandboxBrowsers(sandbox, env);
  shared.set(sandbox, created);
  return created;
}

/**
 * The browse tool. The daemon runs in the turn agent's Daytona sandbox and
 * drives a Browserbase session this server creates. Each (user, agent) gets
 * its own sandbox browser and session, chosen from the turn's context.
 */
export function sandboxBrowseTool(
  sandbox: ComputerSupervisor,
  env: Record<string, string | undefined>,
  agentId = DEFAULT_AGENT_ID,
  options: { fetch?: FetchLike } = {},
): ToolDefinition {
  const browsers = sandboxBrowsers(sandbox, env, options);
  return browseTool({
    actionTimeoutMs: browseTimeoutMs(env),
    unavailable:
      "browse is unavailable: its daemon runs inside the Daytona sandbox, and this server is using the labeled mock computer (MOCK_SANDBOX=1).",
    driver(context) {
      const owner = sandboxOwnerId({ agentId: context.agentId ?? agentId, userId: context.userId });
      return browsers.driver(owner);
    },
  });
}

function failing(error: string): OwnedBrowser {
  return { perform: async () => ({ ok: false, error }) };
}
