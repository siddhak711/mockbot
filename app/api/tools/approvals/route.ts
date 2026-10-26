import { requireApiUser } from "../../../../src/auth/guard";
import { getAppContext } from "../../../../src/context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const actor = await requireApiUser(request);
  if (!actor.ok) return actor.response;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Expected JSON body" }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return Response.json({ error: "Expected JSON body" }, { status: 400 });
  }
  const record = body as { id?: unknown; decision?: unknown };
  const id = typeof record.id === "string" ? record.id.trim() : "";
  const decision = record.decision;
  if (!id) return Response.json({ error: "Approval id is required" }, { status: 400 });
  if (decision !== "approve" && decision !== "deny" && decision !== "stop") {
    return Response.json(
      { error: 'Decision must be "approve", "deny", or "stop"' },
      { status: 400 },
    );
  }
  const { approvals, store } = await getAppContext();
  if (actor.scoped) {
    const conversationId = approvals.pendingConversation(id);
    const owned = conversationId
      ? await store.getConversation(conversationId, undefined, actor.user.id)
      : null;
    if (!owned) {
      return Response.json({ error: "That approval is no longer pending" }, { status: 404 });
    }
  }
  const accepted = decision === "stop" ? approvals.stop(id) : approvals.decide(id, decision);
  if (!accepted)
    return Response.json({ error: "That approval is no longer pending" }, { status: 404 });
  return Response.json({ id, decision });
}
