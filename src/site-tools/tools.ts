import type { BrowserPaths } from "../browser/install";
import { SANDBOX_BROWSER_PATHS } from "../browser/install";
import { SandboxBrowser } from "../browser/sandbox-browser";
import type { ComputerSupervisor } from "../sandbox/supervisor";
import type { ConversationStore } from "../store";
import type { ToolDefinition } from "../tools/types";
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
  let browser: SandboxBrowser | null = null;
  const host = () => options.sandbox?.browserHost() ?? null;
  const deps: SiteToolDeps = {
    repository: new SiteToolRepository(options.store.connection),
    paths,
    env: options.env ?? {},
    host,
    driver() {
      if (browser) return browser;
      const next = host();
      if (!next) return null;
      browser = new SandboxBrowser(next, { paths, install: true });
      return browser;
    },
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
    approval: "never",
    skipHeuristicApproval: true,
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
      return { args: { site, task, ...(name ? { name } : {}) } };
    },
    async invoke(args, context) {
      const minted = await mintSiteTool(
        {
          userId: context.userId ?? "",
          site: String(args.site ?? ""),
          task: String(args.task ?? ""),
          name: typeof args.name === "string" ? args.name : undefined,
          signal: context.signal,
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
    approval: "never",
    skipHeuristicApproval: true,
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Saved site tool name" },
        args: { type: "object", description: "Typed arguments for the saved script" },
      },
      required: ["name"],
      additionalProperties: false,
    },
    prepare(args) {
      const name = typeof args.name === "string" ? args.name.trim() : "";
      if (!name) return { error: "run_site_tool requires a name." };
      const raw = args.args;
      if (raw == null) return { args: { name, args: {} } };
      if (typeof raw === "string") {
        try {
          const parsed = JSON.parse(raw) as unknown;
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            return { error: "run_site_tool args must be an object." };
          }
          return { args: { name, args: parsed } };
        } catch {
          return { error: "run_site_tool args must be an object." };
        }
      }
      if (typeof raw !== "object" || Array.isArray(raw)) {
        return { error: "run_site_tool args must be an object." };
      }
      return { args: { name, args: raw } };
    },
    async invoke(args, context) {
      const ran = await runSiteTool(
        {
          userId: context.userId ?? "",
          name: String(args.name ?? ""),
          args: args.args,
          signal: context.signal,
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
