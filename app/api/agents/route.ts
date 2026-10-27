import { AgentInputError } from "../../../src/agents/directory";
import { requireApiUser } from "../../../src/auth/guard";
import { rosterPreview } from "../../../src/agents/preview";
import { getAgents, getAppContext } from "../../../src/context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export async function GET(request?: Request): Promise<Response> {
  const actor = await requireApiUser(request);
  if (!actor.ok) return actor.response;
  const context = await getAppContext();
  const directory = actor.scoped
    ? (await getAgents(context)).forUser(actor.user.id)
    : await getAgents(context);
  const [agents, grants, latest] = await Promise.all([
    directory.list(),
    directory.listAllGrants(),
    context.store.latestAgentMessages(actor.scoped ? actor.user.id : null),
  ]);
  return Response.json({
    agents: agents.map((agent) => {
      const last = latest.get(agent.id);
      return {
        ...agent,
        grants: grants.filter((grant) => grant.agentId === agent.id),
        preview: last ? rosterPreview(last.content) : "",
        lastMessageAt: last?.createdAt ?? null,
        lastMessageRole: last?.role ?? null,
      };
    }),
  });
}

export async function POST(request: Request): Promise<Response> {
  const actor = await requireApiUser(request);
  if (!actor.ok) return actor.response;
  const context = await getAppContext();
  const directory = actor.scoped
    ? (await getAgents(context)).forUser(actor.user.id)
    : await getAgents(context);
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
    const created = await directory.createWithGrants({
      name: asString(record.name),
      instructions: asString(record.instructions),
      memoryNote: asString(record.memoryNote),
      computerId: asString(record.computerId),
      connectorId: asString(record.connectorId),
    });
    return Response.json(created, { status: 201 });
  } catch (error) {
    if (error instanceof AgentInputError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
