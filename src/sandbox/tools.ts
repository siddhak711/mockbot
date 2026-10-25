import type { ToolContext } from "../tools/types";
import { DEFAULT_AGENT_ID } from "./limits";
import type { ComputerSupervisor } from "./supervisor";
import type { ComputerToolName, ComputerToolResult } from "./types";

/**
 * Same shape as ToolDefinition. registerComputerTools adds each one to the registry.
 */
export type ComputerTool = {
  name: ComputerToolName;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, { type: "string"; description?: string }>;
    required?: readonly string[];
    additionalProperties: false;
  };
  exposure: "default";
  approval: "never";
  prepare: (args: Record<string, unknown>) => { args: Record<string, unknown> } | { error: string };
  invoke: (args: Record<string, unknown>, context: ToolContext) => Promise<ComputerToolResult>;
};

export function createComputerTools(
  supervisor: ComputerSupervisor,
  agentId = DEFAULT_AGENT_ID,
): ComputerTool[] {
  return [
    tool(supervisor, agentId, {
      name: "list",
      description: "List files in this agent's sandbox workspace.",
      properties: {
        path: { type: "string", description: "Directory relative to the workspace. Defaults to ." },
      },
      prepare(args) {
        const path = typeof args.path === "string" && args.path.trim() ? args.path.trim() : ".";
        return { args: { path } };
      },
    }),
    tool(supervisor, agentId, {
      name: "read",
      description: "Read a file in this agent's sandbox workspace.",
      properties: {
        path: { type: "string", description: "File relative to the workspace" },
      },
      required: ["path"],
      prepare(args) {
        if (typeof args.path !== "string" || !args.path.trim()) {
          return { error: "read requires a path." };
        }
        return { args: { path: args.path.trim() } };
      },
    }),
    tool(supervisor, agentId, {
      name: "write",
      description: "Write a file in this agent's sandbox workspace.",
      properties: {
        path: { type: "string", description: "File relative to the workspace" },
        content: { type: "string", description: "Full file contents" },
      },
      required: ["path", "content"],
      prepare(args) {
        if (typeof args.path !== "string" || !args.path.trim()) {
          return { error: "write requires a path." };
        }
        if (typeof args.content !== "string") return { error: "write requires content." };
        return { args: { path: args.path.trim(), content: args.content } };
      },
    }),
    tool(supervisor, agentId, {
      name: "exec",
      description: "Run one command in this agent's sandbox. The command cannot see the host.",
      properties: {
        command: { type: "string", description: "A single command, without pipes or redirection" },
      },
      required: ["command"],
      prepare(args) {
        if (typeof args.command !== "string" || !args.command.trim()) {
          return { error: "exec requires a command." };
        }
        return { args: { command: args.command.trim() } };
      },
    }),
  ];
}

function tool(
  supervisor: ComputerSupervisor,
  agentId: string,
  spec: {
    name: ComputerToolName;
    description: string;
    properties: ComputerTool["inputSchema"]["properties"];
    required?: readonly string[];
    prepare: ComputerTool["prepare"];
  },
): ComputerTool {
  return {
    name: spec.name,
    description: spec.description,
    inputSchema: {
      type: "object",
      properties: spec.properties,
      ...(spec.required ? { required: spec.required } : {}),
      additionalProperties: false,
    },
    exposure: "default",
    approval: "never",
    prepare: spec.prepare,
    async invoke(args, context) {
      const prepared = spec.prepare(args);
      if ("error" in prepared) return { content: prepared.error, isError: true };
      const { result } = await supervisor.invoke(agentId, spec.name, prepared.args, context.signal);
      return result;
    },
  };
}
