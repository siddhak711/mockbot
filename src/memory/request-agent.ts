import { DEFAULT_AGENT_ID } from "../agent";
import { getAgents, getAppContext } from "../context";

export async function memoryAgentFromRequest(
  request?: Request,
  ownerId?: string,
): Promise<{ ok: true; agentId: string } | { ok: false; response: Response }> {
  let agentId = DEFAULT_AGENT_ID;
  let explicit = false;
  if (request) {
    const value = new URL(request.url).searchParams.get("agentId")?.trim();
    if (value) {
      agentId = value;
      explicit = true;
    }
  }
  const context = await getAppContext();
  const directory = await getAgents(context);
  const scoped = ownerId ? directory.forUser(ownerId) : directory;
  if (ownerId && !explicit) {
    const agents = await scoped.list();
    const lead = agents.find((agent) => agent.isLead) ?? agents[0];
    if (!lead) {
      return { ok: false, response: Response.json({ error: "Agent not found" }, { status: 404 }) };
    }
    return { ok: true, agentId: lead.id };
  }
  const agent = await scoped.get(agentId);
  if (!agent) {
    return { ok: false, response: Response.json({ error: "Agent not found" }, { status: 404 }) };
  }
  return { ok: true, agentId: agent.id };
}
