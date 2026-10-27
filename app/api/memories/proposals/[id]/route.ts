import { requireApiUser } from "../../../../../src/auth/guard";
import { getAppContext } from "../../../../../src/context";
import { memoryAgentFromRequest } from "../../../../../src/memory/request-agent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const actor = await requireApiUser(request);
  if (!actor.ok) return actor.response;
  const { id } = await context.params;
  const action = new URL(request.url).searchParams.get("action");
  const selected = await memoryAgentFromRequest(request, actor.scoped ? actor.user.id : undefined);
  if (!selected.ok) return selected.response;
  const { store } = await getAppContext();
  if (action === "dismiss") {
    const dismissed = await store.memories.dismissProposal(selected.agentId, id);
    if (!dismissed.ok) return Response.json({ error: "Inference not found" }, { status: 404 });
    return Response.json({ hiddenUntil: dismissed.hiddenUntil });
  }
  const approved = await store.memories.approveProposal(selected.agentId, id);
  if (!approved.ok) return Response.json({ error: "Inference not found" }, { status: 404 });
  return Response.json({ memory: approved.memory });
}
