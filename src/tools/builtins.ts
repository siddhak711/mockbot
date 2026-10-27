import { askUserTool } from "./ask-user";
import { proposePlanTool } from "./plan";
import { calendarTool } from "./calendar";
import { githubTool } from "./github";
import { toolSearchTool, ToolRegistry } from "./registry";
import type { FetchLike } from "./types";
import { webFetchTool, webSearchTool } from "./web";

export function createDefaultTools(
  env: Record<string, string | undefined>,
  fetchImpl: FetchLike = fetch,
): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(toolSearchTool(registry));
  registry.register(askUserTool());
  registry.register(proposePlanTool());
  registry.register(webSearchTool(env, fetchImpl));
  registry.register(webFetchTool(env, fetchImpl));
  registry.register(githubTool(env, fetchImpl));
  registry.register(calendarTool(env, fetchImpl));
  return registry;
}
