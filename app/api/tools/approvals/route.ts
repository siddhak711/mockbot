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
  const record = body as { id?: unknown; decision?: unknown; conversationId?: unknown };
  const id = typeof record.id === "string" ? record.id.trim() : "";
  const decision = record.decision;
  if (!id) return Response.json({ error: "Approval id is required" }, { status: 400 });
  if (decision !== "approve" && decision !== "deny" && decision !== "stop") {
    return Response.json(
      { error: 'Decision must be "approve", "deny", or "stop"' },
      { status: 400 },
    );
  }
  const requested =
    typeof record.conversationId === "string" && record.conversationId.trim()
      ? record.conversationId.trim()
      : undefined;
  const { approvals, store } = await getAppContext();
  // Call ids repeat across conversations. Settle only a call in a conversation
  // this account owns, and only when that names exactly one pending call.
  let candidates = approvals
    .pendingConversations(id)
    .filter((conversationId) => requested === undefined || conversationId === requested);
  if (actor.scoped) {
    const owned: (string | null)[] = [];
    for (const conversationId of candidates) {
      if (!conversationId) continue;
      if (await store.getConversation(conversationId, undefined, actor.user.id)) {
        owned.push(conversationId);
      }
    }
    candidates = owned;
  }
  if (candidates.length > 1) {
    return Response.json(
      { error: "Several conversations wait on that id. Send conversationId." },
      { status: 409 },
    );
  }
  if (candidates.length === 0) {
    return Response.json({ error: "That approval is no longer pending" }, { status: 404 });
  }
  const target = candidates[0] ?? null;
  const accepted =
    decision === "stop" ? approvals.stop(id, target) : approvals.decide(id, decision, target);
  if (!accepted)
    return Response.json({ error: "That approval is no longer pending" }, { status: 404 });
  return Response.json({ id, decision });
}
