import { LEAD_AGENT_ID } from "./ids";
import type { Agent, AgentGrant, AgentMemoryFact } from "./types";

export function buildAgentSystemPrompt(input: {
  agent: Agent;
  memories: readonly AgentMemoryFact[];
  grants: readonly Pick<AgentGrant, "kind" | "resourceId">[];
  child: boolean;
}): string {
  const computers = input.grants
    .filter((grant) => grant.kind === "computer")
    .map((grant) => grant.resourceId);
  const connectors = input.grants
    .filter((grant) => grant.kind === "connector")
    .map((grant) => grant.resourceId);
  const scoped =
    input.child ||
    input.agent.id !== LEAD_AGENT_ID ||
    input.memories.length > 0 ||
    computers.length > 0 ||
    connectors.length > 0;
  if (!scoped) return input.agent.instructions;

  const lines = ["# Agent", `name: ${input.agent.name}`];
  if (input.child) lines.push("delegation: child");
  if (input.memories.length > 0) {
    lines.push("memories:");
    for (const memory of input.memories) {
      const content = memory.content.replace(/\s+/g, " ").trim();
      lines.push(`- ${memory.key}: ${content}`);
    }
  }
  if (computers.length > 0) lines.push(`computers: ${computers.join(", ")}`);
  if (connectors.length > 0) lines.push(`connectors: ${connectors.join(", ")}`);
  if (computers.length > 0 || connectors.length > 0) {
    lines.push(
      "Use use_computer only for a listed computer and use_connector only for a listed connector.",
    );
  }
  return `${input.agent.instructions}\n\n${lines.join("\n")}`;
}
