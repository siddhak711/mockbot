import { requireApiUser } from "../../../../src/auth/guard";
import { getAppContext } from "../../../../src/context";
import { listRunEvents, runConversationId, runTotals } from "../../../../src/runs/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const actor = await requireApiUser(request);
  if (!actor.ok) return actor.response;
  const { id } = await context.params;
  const { store } = await getAppContext();
  if (actor.scoped) {
    // Run events hold the full model input. Only the conversation's owner reads them.
    const conversationId = await runConversationId(store.connection, id);
    const owned = conversationId
      ? await store.getConversation(conversationId, undefined, actor.user.id)
      : null;
    if (!owned) return Response.json({ error: "Run not found" }, { status: 404 });
  }
  const events = await listRunEvents(store.connection, id);
  return Response.json({ runId: id, totals: runTotals(events), events });
}
