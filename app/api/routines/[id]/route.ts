import { requireApiUser } from "../../../../src/auth/guard";
import { getAppContext } from "../../../../src/context";
import type { RoutineStatus } from "../../../../src/routines/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, context: RouteContext): Promise<Response> {
  const actor = await requireApiUser(request);
  if (!actor.ok) return actor.response;
  const { id } = await context.params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Expected JSON body" }, { status: 400 });
  }
  const status =
    body && typeof body === "object" && "status" in body
      ? (body as { status?: unknown }).status
      : undefined;
  if (status !== "active" && status !== "paused") {
    return Response.json({ error: "Status must be active or paused" }, { status: 400 });
  }
  const { routines } = await getAppContext();
  if (!routines) return Response.json({ error: "Routines are not available" }, { status: 500 });
  const routine = await routines.setStatus(
    id,
    status as RoutineStatus,
    new Date(),
    actor.scoped ? actor.user.id : undefined,
  );
  if (!routine) return Response.json({ error: "Routine not found" }, { status: 404 });
  return Response.json({ routine, runs: await routines.listRuns(routine.id) });
}
