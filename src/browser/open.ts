import type { ComputerSupervisor } from "../sandbox/supervisor";
import { DEFAULT_AGENT_ID } from "../sandbox/limits";
import { sandboxOwnerId } from "../sandbox/owner";
import { BrowserbaseSessions, readBrowserbaseSettings } from "./browserbase";
import { SANDBOX_BROWSER_PATHS } from "./install";
import { browseTimeoutMs } from "./limits";
import { SandboxBrowser } from "./sandbox-browser";
import { browseTool } from "./tool";
import type { BrowserDriver } from "./types";
import type { ToolDefinition } from "../tools/types";

/**
 * The browse tool. The daemon runs in the turn agent's Daytona sandbox and
 * drives a Browserbase session this server creates. Each (user, agent) gets
 * its own sandbox browser and session, chosen from the turn's context.
 */
export function sandboxBrowseTool(
  sandbox: ComputerSupervisor,
  env: Record<string, string | undefined>,
  agentId = DEFAULT_AGENT_ID,
  options: { fetch?: (input: string, init?: RequestInit) => Promise<Response> } = {},
): ToolDefinition {
  const browsers = new Map<string, SandboxBrowser>();
  const browserbase = readBrowserbaseSettings(env);
  return browseTool({
    actionTimeoutMs: browseTimeoutMs(env),
    unavailable:
      "browse is unavailable: its daemon runs inside the Daytona sandbox, and this server is using the labeled mock computer (MOCK_SANDBOX=1).",
    driver(context) {
      const owner = sandboxOwnerId({ agentId: context.agentId ?? agentId, userId: context.userId });
      const existing = browsers.get(owner);
      if (existing) return existing;
      const host = sandbox.browserHost(owner);
      if (!host) return null;
      if (!browserbase.ok) return failing(browserbase.error);
      const browser = new SandboxBrowser(host, {
        paths: SANDBOX_BROWSER_PATHS,
        install: true,
        sessions: new BrowserbaseSessions(browserbase.settings, { fetch: options.fetch }),
      });
      browsers.set(owner, browser);
      return browser;
    },
  });
}

function failing(error: string): BrowserDriver {
  return { perform: async () => ({ ok: false, error }) };
}
