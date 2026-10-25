import { AgentInputError } from "../../../src/agents/directory";
import type { AgentGrant } from "../../../src/agents/types";
import { getAgents, getAppContext } from "../../../src/context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export async function GET(): Promise<Response> {
  const context = await getAppContext();
  const directory = await getAgents(context);
  const [agents, grants] = await Promise.all([directory.list(), directory.listAllGrants()]);
  return Response.json({
    agents: agents.map((agent) => ({
      ...agent,
      grants: grants.filter((grant) => grant.agentId === agent.id),
    })),
  });
}

export async function POST(request: Request): Promise<Response> {
  const context = await getAppContext();
  const directory = await getAgents(context);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Expected JSON body" }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return Response.json({ error: "Expected JSON body" }, { status: 400 });
  }
  const record = body as {
    name?: unknown;
    instructions?: unknown;
    memoryNote?: unknown;
    computerId?: unknown;
    connectorId?: unknown;
  };
  try {
    const agent = await directory.create({
      name: asString(record.name),
      instructions: asString(record.instructions),
      memoryNote: asString(record.memoryNote),
    });
    const grants: AgentGrant[] = [];
    const computerId = asString(record.computerId).trim();
    const connectorId = asString(record.connectorId).trim();
    if (computerId) grants.push(await directory.grant(agent.id, "computer", computerId));
    if (connectorId) grants.push(await directory.grant(agent.id, "connector", connectorId));
    return Response.json({ agent, grants }, { status: 201 });
  } catch (error) {
    if (error instanceof AgentInputError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
