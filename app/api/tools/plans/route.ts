import { requireApiUser } from "../../../../src/auth/guard";
import { getAppContext } from "../../../../src/context";
import { PROPOSE_PLAN_TOOL, parsePlanSteps } from "../../../../src/tools/plan";

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
  const record = body as { id?: unknown; decision?: unknown; steps?: unknown };
  const id = typeof record.id === "string" ? record.id.trim() : "";
  if (!id) return Response.json({ error: "Plan id is required" }, { status: 400 });
  const decision = record.decision;
  if (
    decision !== "approve" &&
    decision !== "edit" &&
    decision !== "cancel" &&
    decision !== "stop"
  ) {
    return Response.json(
      { error: 'Decision must be "approve", "edit", or "cancel"' },
      { status: 400 },
    );
  }
  const { plans, store } = await getAppContext();
  if (actor.scoped) {
    const conversationId = plans.pendingConversation(id);
    const owned = conversationId
      ? await store.getConversation(conversationId, undefined, actor.user.id)
      : null;
    if (!owned) {
      return Response.json({ error: "That plan is no longer waiting" }, { status: 404 });
    }
  }
  const pending = plans.snapshot(id);
  if (!pending) {
    return Response.json({ error: "That plan is no longer waiting" }, { status: 404 });
  }

  if (decision === "edit" || (decision === "approve" && record.steps !== undefined)) {
    const parsed = parsePlanSteps({ steps: record.steps });
    if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
    const edited = plans.edit(id, parsed.steps);
    if (edited === "missing") {
      return Response.json({ error: "That plan is no longer waiting" }, { status: 404 });
    }
    if (edited === "rejected") {
      return Response.json({ error: "Those steps are not a valid plan" }, { status: 400 });
    }
    const saved = plans.snapshot(id);
    if (!saved) {
      return Response.json({ error: "That plan is no longer waiting" }, { status: 404 });
    }
    await store.saveToolCall({
      id,
      conversationId: saved.conversationId,
      messageId: saved.messageId,
      name: PROPOSE_PLAN_TOOL,
      arguments: JSON.stringify({ steps: saved.steps }),
      status: "plan",
      output: null,
    });
    if (decision === "edit") return Response.json({ id, decision: "edit", steps: saved.steps });
  }

  if (decision === "cancel" || decision === "stop") {
    const accepted = plans.cancel(id);
    if (!accepted) {
      return Response.json({ error: "That plan is no longer waiting" }, { status: 404 });
    }
    return Response.json({ id, decision: "cancel" });
  }

  const approved = plans.snapshot(id);
  const accepted = plans.approve(id);
  if (accepted === "missing") {
    return Response.json({ error: "That plan is no longer waiting" }, { status: 404 });
  }
  return Response.json({ id, decision: "approve", steps: approved?.steps });
}
