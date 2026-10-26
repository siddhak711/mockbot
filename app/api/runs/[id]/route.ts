import { requireApiUser } from "../../../../src/auth/guard";
import { getAppContext } from "../../../../src/context";
import { listRunEvents, runTotals } from "../../../../src/runs/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const actor = await requireApiUser(request);
  if (!actor.ok) return actor.response;
  const { id } = await context.params;
  const { store } = await getAppContext();
  const events = await listRunEvents(store.connection, id);
  if (events.length === 0) return Response.json({ error: "Run not found" }, { status: 404 });
  return Response.json({ runId: id, totals: runTotals(events), events });
}
