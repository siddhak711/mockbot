import { DEFAULT_AGENT_ID } from "../agent";
import { getAgents, getAppContext } from "../context";

export async function memoryAgentFromRequest(
  request?: Request,
): Promise<{ ok: true; agentId: string } | { ok: false; response: Response }> {
  let agentId = DEFAULT_AGENT_ID;
  if (request) {
    const value = new URL(request.url).searchParams.get("agentId")?.trim();
    if (value) agentId = value;
  }
  const context = await getAppContext();
  const agent = await (await getAgents(context)).get(agentId);
  if (!agent) {
    return { ok: false, response: Response.json({ error: "Agent not found" }, { status: 404 }) };
  }
  return { ok: true, agentId: agent.id };
}
