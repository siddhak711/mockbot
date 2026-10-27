import { requireApiUser } from "../../../../../src/auth/guard";
import { getAgents, getAppContext } from "../../../../../src/context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/** The one persistent thread for this agent and the signed-in user. */
export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const actor = await requireApiUser(request);
  if (!actor.ok) return actor.response;
  const { id } = await context.params;
  const app = await getAppContext();
  const directory = actor.scoped
    ? (await getAgents(app)).forUser(actor.user.id)
    : await getAgents(app);
  const agent = await directory.get(id);
  if (!agent) return Response.json({ error: "Agent not found" }, { status: 404 });
  const userId = actor.scoped ? actor.user.id : null;
  const conversation = await app.store.getOrCreateAgentConversation(agent.id, userId);
  const found = await app.store.getConversation(
    conversation.id,
    agent.id,
    actor.scoped ? actor.user.id : undefined,
  );
  if (!found) return Response.json({ error: "Conversation not found" }, { status: 404 });
  return Response.json(found);
}
