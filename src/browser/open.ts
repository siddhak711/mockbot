import type { ComputerSupervisor } from "../sandbox/supervisor";
import { DEFAULT_AGENT_ID } from "../sandbox/limits";
import { sandboxOwnerId } from "../sandbox/owner";
import { SANDBOX_BROWSER_PATHS } from "./install";
import { browseTimeoutMs } from "./limits";
import { SandboxBrowser } from "./sandbox-browser";
import { browseTool } from "./tool";
import type { ToolDefinition } from "../tools/types";

/**
 * The browse tool backed by the turn agent's Daytona sandbox. Each (user, agent)
 * gets its own browser, chosen from the turn's context at invoke time.
 */
export function sandboxBrowseTool(
  sandbox: ComputerSupervisor,
  env: Record<string, string | undefined>,
  agentId = DEFAULT_AGENT_ID,
): ToolDefinition {
  const browsers = new Map<string, SandboxBrowser>();
  return browseTool({
    actionTimeoutMs: browseTimeoutMs(env),
    unavailable:
      "browse is unavailable: it runs headless Chromium inside the Daytona sandbox, and DAYTONA_API_KEY is not set, so this server uses the mock computer.",
    driver(context) {
      const owner = sandboxOwnerId({ agentId: context.agentId ?? agentId, userId: context.userId });
      const existing = browsers.get(owner);
      if (existing) return existing;
      const host = sandbox.browserHost(owner);
      if (!host) return null;
      const browser = new SandboxBrowser(host, { paths: SANDBOX_BROWSER_PATHS, install: true });
      browsers.set(owner, browser);
      return browser;
    },
  });
}
