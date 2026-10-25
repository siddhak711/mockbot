import type { LlmProvider } from "../llm";
import type { ConversationStore } from "../store";
import { performDelegation } from "./delegate";
import type { AgentDirectory } from "./directory";
import { DELEGATE_TOOL_NAME } from "./ids";
import type { AgentMemoryPort, ComputerPort, ConnectorPort } from "./types";

/**
 * Subset of the milestone 2 tool definition (src/tools/types.ts).
 * `registerDelegateTool` can be pointed at ToolRegistry.register when that file lands.
 */
export type AgentToolResult = {
  content: string;
  isError?: boolean;
};

export type AgentToolContext = {
  signal?: AbortSignal;
};

export type AgentTool = {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, { type: "string"; description?: string }>;
    required?: readonly string[];
    additionalProperties?: boolean;
  };
  exposure?: "pinned" | "default" | "hidden";
  approval?: "always" | "never";
  invoke: (args: Record<string, unknown>, context: AgentToolContext) => Promise<AgentToolResult>;
};

export interface AgentToolHost {
  register(tool: AgentTool): void;
  get(name: string): AgentTool | undefined;
}

export class MapToolHost implements AgentToolHost {
  #tools = new Map<string, AgentTool>();

  register(tool: AgentTool): void {
    if (this.#tools.has(tool.name)) {
      throw new Error(`Tool ${tool.name} is already registered`);
    }
    this.#tools.set(tool.name, tool);
  }

  get(name: string): AgentTool | undefined {
    return this.#tools.get(name);
  }
}

export type DelegateDeps = {
  directory: AgentDirectory;
  store: ConversationStore;
  provider: LlmProvider;
  memory: AgentMemoryPort;
  computer: ComputerPort;
  connector: ConnectorPort;
  /** Conversation owner. The delegate tool is only registered for the lead. */
  parentAgentId: string;
};

export function delegateTool(deps: DelegateDeps): AgentTool {
  return {
    name: DELEGATE_TOOL_NAME,
    description:
      "Hand a subtask to another agent. That agent replies in its own conversation, with its own instructions, memories, and grants. Returns the child's result.",
    exposure: "default",
    approval: "never",
    inputSchema: {
      type: "object",
      properties: {
        agent: { type: "string", description: "Agent name" },
        task: { type: "string", description: "Subtask for that agent" },
      },
      required: ["agent", "task"],
      additionalProperties: false,
    },
    async invoke(args, context) {
      const outcome = await performDelegation(args, { ...deps, signal: context.signal });
      return { content: outcome.content, isError: outcome.isError };
    },
  };
}

export function registerDelegateTool(host: AgentToolHost, deps: DelegateDeps): void {
  host.register(delegateTool(deps));
}
