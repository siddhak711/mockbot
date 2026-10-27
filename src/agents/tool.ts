import type { LlmProvider } from "../llm";
import type { RunLog } from "../runs/events";
import type { ConversationStore } from "../store";
import { ToolRegistry } from "../tools/registry";
import type { ToolDefinition } from "../tools/types";
import { performDelegation } from "./delegate";
import type { AgentDirectory } from "./directory";
import { DELEGATE_TOOL_NAME, isLeadAgent } from "./ids";
import type { AgentMemoryPort, ComputerPort, ConnectorPort } from "./types";

/** Subset of the tool definition in src/tools/types.ts. */
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

export type DelegateDeps = {
  directory: AgentDirectory;
  store: ConversationStore;
  provider: LlmProvider;
  memory: AgentMemoryPort;
  computer: ComputerPort;
  connector: ConnectorPort;
  /** Conversation owner. The delegate tool is only registered for the lead. */
  parentAgentId: string;
  /** Account that owns the child conversation. Omitted for the unscoped test path. */
  userId?: string;
  /** When set, the child model call and the delegate tool are written to this run. */
  runLog?: RunLog;
};

export function delegateTool(deps: DelegateDeps): AgentTool {
  return {
    name: DELEGATE_TOOL_NAME,
    description:
      "Hand a subtask to another agent. The task is appended to that agent's one conversation. The agent uses its own instructions, memories, and grants. Returns the child's result.",
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

/** Lead conversations see `delegate`. Every other agent keeps the shared registry unchanged. */
export function toolsForSpeaker(
  base: ToolRegistry,
  speaker: { id: string; isLead?: boolean },
  deps: DelegateDeps,
): ToolRegistry {
  if (!isLeadAgent(speaker) || base.get(DELEGATE_TOOL_NAME)) return base;
  const copy = new ToolRegistry();
  for (const tool of base.list()) copy.register(tool);
  copy.register(delegateTool(deps) as ToolDefinition);
  return copy;
}
