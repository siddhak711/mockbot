import { MAX_EXPOSED_TOOLS, type ToolDefinition } from "./types";

function exposureOf(tool: ToolDefinition): "pinned" | "default" | "hidden" {
  return tool.exposure ?? "default";
}

export class ToolRegistry {
  #tools: ToolDefinition[] = [];

  register(tool: ToolDefinition): void {
    if (this.#tools.some((item) => item.name === tool.name)) {
      throw new Error(`Tool ${tool.name} is already registered`);
    }
    this.#tools.push(tool);
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
    const seen = new Set<string>();
    const exposed: ToolDefinition[] = [];
    for (const tool of [...pinned, ...discovered, ...defaults]) {
      if (seen.has(tool.name)) continue;
      seen.add(tool.name);
      exposed.push(tool);
      if (exposed.length >= cap) break;
    }
    return exposed;
  }
}
