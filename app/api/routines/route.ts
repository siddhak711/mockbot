import { requireApiUser } from "../../../src/auth/guard";
import { getAppContext } from "../../../src/context";
import type { Routine, RoutineRun } from "../../../src/routines/types";
import { RoutineInputError } from "../../../src/routines/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export async function GET(request?: Request): Promise<Response> {
  const actor = await requireApiUser(request);
  if (!actor.ok) return actor.response;
  const { routines } = await getAppContext();
  if (!routines) return Response.json({ error: "Routines are not available" }, { status: 500 });
  const listed = await routines.list(actor.scoped ? actor.user.id : undefined);
  const withRuns: Array<Routine & { runs: RoutineRun[] }> = await Promise.all(
    listed.map(async (routine) => ({ ...routine, runs: await routines.listRuns(routine.id) })),
  );
  return Response.json({ routines: withRuns });
}

export async function POST(request: Request): Promise<Response> {
  const actor = await requireApiUser(request);
  if (!actor.ok) return actor.response;
  const body = await readJson(request);
  if (!body || typeof body !== "object") {
    return Response.json({ error: "Expected JSON body" }, { status: 400 });
  }
  const record = body as { name?: unknown; prompt?: unknown; cron?: unknown; eventName?: unknown };
  const { routines, store } = await getAppContext();
  if (!routines) return Response.json({ error: "Routines are not available" }, { status: 500 });
  const userId = actor.scoped ? actor.user.id : null;
  let agentId: string | null = null;
  if (userId) {
    const lead = await store.connection.query<{ id: string }>(
      `SELECT id
       FROM agents
       WHERE user_id = $1 AND is_lead = TRUE
       ORDER BY created_at ASC, id ASC
       LIMIT 1`,
      [userId],
    );
    agentId = lead.rows[0]?.id ?? null;
  }
  try {
    const routine = await routines.create({
      name: text(record.name),
      prompt: text(record.prompt),
      cron: typeof record.cron === "string" ? record.cron : undefined,
      eventName: typeof record.eventName === "string" ? record.eventName : undefined,
      now: new Date(),
      userId,
      agentId,
    });
    return Response.json({ routine }, { status: 201 });
  } catch (error) {
    if (error instanceof RoutineInputError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }
}
