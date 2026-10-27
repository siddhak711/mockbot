import { createHash } from "node:crypto";
import { DEFAULT_AGENT_ID, normalizeAgentId } from "./limits";

/**
 * The sandbox a tool call runs in: one per (user, agent). The lead agent's id
 * is shared by every user, so a signed-in user's id is folded into the key.
 * DEFAULT_AGENT_ID applies only when the caller has no agent at all.
 */
export function sandboxOwnerId(owner: { agentId?: string | null; userId?: string | null }): string {
  const agentId = owner.agentId?.trim() || DEFAULT_AGENT_ID;
  const userId = owner.userId?.trim();
  if (!userId) return normalizeAgentId(agentId) ?? hashed("a", agentId);
  return hashed("u", `${userId}\n${agentId}`);
}

function hashed(prefix: string, value: string): string {
  return `${prefix}-${createHash("sha256").update(value).digest("hex").slice(0, 40)}`;
}
