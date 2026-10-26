import type { ComputerSupervisor } from "../sandbox/supervisor";
import { DEFAULT_AGENT_ID } from "../sandbox/limits";
import { SANDBOX_BROWSER_PATHS } from "./install";
import { browseTimeoutMs } from "./limits";
import { SandboxBrowser } from "./sandbox-browser";
import { browseTool } from "./tool";
import type { ToolDefinition } from "../tools/types";

/** The browse tool backed by the agent's Daytona sandbox. One browser per supervisor. */
export function sandboxBrowseTool(
  sandbox: ComputerSupervisor,
  env: Record<string, string | undefined>,
  agentId = DEFAULT_AGENT_ID,
): ToolDefinition {
  let browser: SandboxBrowser | null = null;
  return browseTool({
    actionTimeoutMs: browseTimeoutMs(env),
    unavailable:
      "browse is unavailable: it runs headless Chromium inside the Daytona sandbox, and DAYTONA_API_KEY is not set, so this server uses the mock computer.",
    driver() {
      if (browser) return browser;
      const host = sandbox.browserHost(agentId);
      if (!host) return null;
      browser = new SandboxBrowser(host, { paths: SANDBOX_BROWSER_PATHS, install: true });
      return browser;
    },
  });
}
