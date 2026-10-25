import { clip, isAbortError } from "./http";
import { MAX_EXPOSED_TOOLS, type ToolContext, type ToolDefinition, type ToolResult } from "./types";

function exposureOf(tool: ToolDefinition): "pinned" | "default" | "hidden" {
  return tool.exposure ?? "default";
}

function unique(tools: ToolDefinition[]): ToolDefinition[] {
  const seen = new Set<string>();
  const ordered: ToolDefinition[] = [];
  for (const tool of tools) {
    if (seen.has(tool.name)) continue;
    seen.add(tool.name);
    ordered.push(tool);
  }
  return ordered;
}

function scoreTool(tool: ToolDefinition, query: string, terms: string[]): number {
  const name = tool.name.toLowerCase();
  const description = tool.description.toLowerCase();
  let score = 0;
  if (name === query) score += 100;
  else if (query && name.includes(query)) score += 40;
  if (query && description.includes(query)) score += 20;
  for (const term of terms) {
    if (name.includes(term)) score += 10;
    if (description.includes(term)) score += 3;
  }
  return score;
}

export class ToolRegistry {
  #tools: ToolDefinition[] = [];
  #sources = new Map<string, string>();

  register(tool: ToolDefinition, source = "builtin"): void {
    if (this.#tools.some((item) => item.name === tool.name)) {
      throw new Error(`Tool ${tool.name} is already registered`);
    }
    this.#tools.push(tool);
    this.#sources.set(tool.name, source);
  }

  removeSource(source: string): void {
    this.#tools = this.#tools.filter((tool) => this.#sources.get(tool.name) !== source);
    for (const [name, itemSource] of this.#sources) {
      if (itemSource === source) this.#sources.delete(name);
    }
  }

  get(name: string): ToolDefinition | undefined {
    return this.#tools.find((tool) => tool.name === name);
  }

  list(): readonly ToolDefinition[] {
    return this.#tools;
  }

  exposed(options?: { promoted?: Iterable<string>; limit?: number }): ToolDefinition[] {
    const requested = options?.limit ?? MAX_EXPOSED_TOOLS;
    const cap = Math.max(1, Math.min(requested, MAX_EXPOSED_TOOLS));
    const promoted = new Set(options?.promoted ?? []);
    const pinned = this.#tools.filter((tool) => exposureOf(tool) === "pinned");
    const discovered = this.#tools.filter(
      (tool) => promoted.has(tool.name) && exposureOf(tool) === "hidden",
    );
    const defaults = this.#tools.filter((tool) => exposureOf(tool) === "default");
    return unique([...pinned, ...discovered, ...defaults]).slice(0, cap);
  }

  search(query: string, limit = 5): ToolDefinition[] {
    const normalized = query.toLowerCase().trim();
    const terms = normalized.split(/\s+/).filter(Boolean);
    const cap = Math.max(1, Math.min(limit, 8));
    return this.#tools
      .filter((tool) => tool.name !== "tool_search")
      .map((tool) => ({ tool, score: scoreTool(tool, normalized, terms) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
      .slice(0, cap)
      .map((item) => item.tool);
  }
}

export async function runTool(
  tool: ToolDefinition,
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolResult> {
  try {
    const result = await tool.invoke(args, context);
    const content = result.content.trim() ? clip(result.content) : "The tool returned no content.";
    return { content, isError: result.isError };
  } catch (error) {
    if (isAbortError(error)) throw error;
    const message = error instanceof Error ? error.message : "The tool failed";
    return { content: message, isError: true };
  }
}

export function toolSearchTool(registry: ToolRegistry): ToolDefinition {
  return {
    name: "tool_search",
    description:
      "Find tools by name or description. Matching tools that were not already listed become available on the next step. The model only sees 15 tools at a time.",
    exposure: "pinned",
    approval: "never",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Words from the tool name or description" },
        limit: { type: "integer", description: "Maximum matches to return, up to 8" },
      },
      required: ["query"],
      additionalProperties: false,
    },
    prepare(args) {
      const query = typeof args.query === "string" ? args.query.trim() : "";
      if (!query) return { error: "tool_search requires a query string." };
      const limit =
        typeof args.limit === "number" && Number.isFinite(args.limit) ? Math.trunc(args.limit) : 5;
      return { args: { query, limit } };
    },
    async invoke(args, context) {
      const query = String(args.query ?? "");
      const limit = typeof args.limit === "number" ? args.limit : 5;
      const matches = registry.search(query, limit);
      context.promote?.(matches.map((tool) => tool.name));
      return {
        content: JSON.stringify(
          {
            query,
            matches: matches.map((tool) => ({
              name: tool.name,
              description: tool.description,
              parameters: tool.inputSchema,
            })),
          },
          null,
          2,
        ),
      };
    },
  };
}
