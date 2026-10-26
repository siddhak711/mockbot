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
  const record = body as { id?: unknown; answer?: unknown; decision?: unknown };
  const id = typeof record.id === "string" ? record.id.trim() : "";
  if (!id) return Response.json({ error: "Question id is required" }, { status: 400 });
  const decision = record.decision;
  const answer = typeof record.answer === "string" ? record.answer : "";
  if (decision !== "stop" && !answer.trim()) {
    return Response.json({ error: "Answer is required" }, { status: 400 });
  }
  if (decision !== undefined && decision !== "stop") {
    return Response.json({ error: 'Decision must be "stop"' }, { status: 400 });
  }
  const { asks, store } = await getAppContext();
  if (actor.scoped) {
    const conversationId = asks.pendingConversation(id);
    const owned = conversationId
      ? await store.getConversation(conversationId, undefined, actor.user.id)
      : null;
    if (!owned) {
      return Response.json({ error: "That question is no longer waiting" }, { status: 404 });
    }
  }
  if (decision === "stop") {
    const accepted = asks.stop(id);
    if (!accepted) {
      return Response.json({ error: "That question is no longer waiting" }, { status: 404 });
    }
    return Response.json({ id, decision: "stop" });
  }
  const accepted = asks.answer(id, answer);
  if (accepted === "missing") {
    return Response.json({ error: "That question is no longer waiting" }, { status: 404 });
  }
  if (accepted === "rejected") {
    return Response.json({ error: "That answer is not one of the options" }, { status: 400 });
  }
  return Response.json({ id, answer: answer.trim() });
}
