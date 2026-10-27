import type { BrowserPaths } from "../browser/install";
import { SANDBOX_BROWSER_PATHS } from "../browser/install";
import { sandboxBrowsers } from "../browser/open";
import { DEFAULT_AGENT_ID } from "../sandbox/limits";
import { sandboxOwnerId } from "../sandbox/owner";
import type { ComputerSupervisor } from "../sandbox/supervisor";
import type { ConversationStore } from "../store";
import type { ToolDefinition } from "../tools/types";
import { siteToolCallNeedsApproval } from "./approval";
import { mintSiteTool, runSiteTool } from "./mint";
import { SiteToolRepository } from "./repository";
import type { SiteToolDeps } from "./types";

export const MINT_SITE_TOOL = "mint_site_tool";
export const RUN_SITE_TOOL = "run_site_tool";

export function createSiteTools(deps: SiteToolDeps): ToolDefinition[] {
  return [mintTool(deps), runTool(deps)];
}

export function siteToolsForApp(options: {
  store: ConversationStore;
  sandbox?: ComputerSupervisor;
  env?: Record<string, string | undefined>;
  paths?: BrowserPaths;
}): ToolDefinition[] {
  const paths = options.paths ?? SANDBOX_BROWSER_PATHS;
  const env = options.env ?? {};
  // The same per-owner browsers the browse tool drives, so both share one daemon.
  const browsers = options.sandbox ? sandboxBrowsers(options.sandbox, env) : null;
  const ownerOf = (owner?: string) => owner ?? DEFAULT_AGENT_ID;
  const deps: SiteToolDeps = {
    repository: new SiteToolRepository(options.store.connection),
    paths,
    env,
    host: (owner) => browsers?.host(ownerOf(owner)) ?? null,
    driver: (owner) => browsers?.driver(ownerOf(owner)) ?? null,
    scriptSessions: () =>
      browsers?.scriptSessions() ?? { error: "Site tools have no Daytona sandbox." },
  };
  return createSiteTools(deps);
}

function mintTool(deps: SiteToolDeps): ToolDefinition {
  return {
    name: MINT_SITE_TOOL,
    description:
      "Explore a site with the sandbox browser and save a reusable Playwright site tool with a typed JSON schema. " +
      "The script is saved only after it runs once on the live site and a self-check review passes. Minting the same name again stores a new version.",
    exposure: "hidden",
    approval: (args, context) => siteToolCallNeedsApproval("mint", args, context, deps),
    inputSchema: {
      type: "object",
      properties: {
        site: { type: "string", description: "http or https site to explore" },
        task: {
          type: "string",
          description:
            "What the tool should do, such as extract the text of #price or type {query: widgets} into #search",
        },
        name: {
          type: "string",
          description: "Optional stable name. Defaults to a slug of the task.",
        },
        confirm: {
          type: "boolean",
          description:
            "Set when the task submits a form or clicks a submit control. The user approves first.",
        },
      },
      required: ["site", "task"],
      additionalProperties: false,
    },
    prepare(args) {
      const site = typeof args.site === "string" ? args.site.trim() : "";
      const task = typeof args.task === "string" ? args.task.trim() : "";
      if (!site) return { error: "mint_site_tool requires a site." };
      if (!task) return { error: "mint_site_tool requires a task." };
      const name = typeof args.name === "string" ? args.name.trim() : "";
      return {
        args: {
          site,
          task,
          ...(name ? { name } : {}),
          ...(args.confirm === true ? { confirm: true } : {}),
        },
      };
    },
    async invoke(args, context) {
      const userId = context.userId?.trim();
      if (!userId) return { content: "Sign in before minting a site tool.", isError: true };
      const allowSubmit = await siteToolCallNeedsApproval("mint", args, context, deps);
      const minted = await mintSiteTool(
        {
          userId,
          site: String(args.site ?? ""),
          task: String(args.task ?? ""),
          name: typeof args.name === "string" ? args.name : undefined,
          owner: turnOwner(context),
          signal: context.signal,
          allowSubmit,
        },
        deps,
      );
      if (!minted.saved) return { content: minted.error, isError: true };
      return {
        content: JSON.stringify(
          {
            saved: true,
            name: minted.name,
            version: minted.version,
            schema: minted.schema,
            sampleArgs: minted.sampleArgs,
            explored: minted.explored,
            review: minted.review,
            result: minted.run.result,
          },
          null,
          2,
        ),
      };
    },
  };
}

function runTool(deps: SiteToolDeps): ToolDefinition {
  return {
    name: RUN_SITE_TOOL,
    description:
      "Replay a saved site tool by name. args must match the tool's typed JSON schema. Uses the latest version for this user.",
    exposure: "hidden",
    approval: (args, context) => siteToolCallNeedsApproval("run", args, context, deps),
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Saved site tool name" },
        args: { type: "object", description: "Typed arguments for the saved script" },
        confirm: {
          type: "boolean",
          description:
            "Set when the saved script submits a form or clicks a submit control. The user approves first.",
        },
      },
      required: ["name"],
      additionalProperties: false,
    },
    prepare(args) {
      const name = typeof args.name === "string" ? args.name.trim() : "";
      if (!name) return { error: "run_site_tool requires a name." };
      const confirm = args.confirm === true ? { confirm: true as const } : {};
      const raw = args.args;
      if (raw == null) return { args: { name, args: {}, ...confirm } };
      if (typeof raw === "string") {
        try {
          const parsed = JSON.parse(raw) as unknown;
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            return { error: "run_site_tool args must be an object." };
          }
          return { args: { name, args: parsed, ...confirm } };
        } catch {
          return { error: "run_site_tool args must be an object." };
        }
      }
      if (typeof raw !== "object" || Array.isArray(raw)) {
        return { error: "run_site_tool args must be an object." };
      }
      return { args: { name, args: raw, ...confirm } };
    },
    async invoke(args, context) {
      const userId = context.userId?.trim();
      if (!userId) return { content: "Sign in before running a site tool.", isError: true };
      const allowSubmit = await siteToolCallNeedsApproval("run", args, context, deps);
      const ran = await runSiteTool(
        {
          userId,
          name: String(args.name ?? ""),
          args: args.args,
          owner: turnOwner(context),
          signal: context.signal,
          allowSubmit,
        },
        deps,
      );
      if (!ran.ok) return { content: ran.error, isError: true };
      return {
        content: JSON.stringify(
          { name: ran.name, version: ran.version, result: ran.result },
          null,
          2,
        ),
      };
    },
  };
}

/** The (user, agent) sandbox this turn's browse tool uses. */
function turnOwner(context: { agentId?: string; userId?: string | null }): string {
  return sandboxOwnerId({ agentId: context.agentId ?? DEFAULT_AGENT_ID, userId: context.userId });
}
