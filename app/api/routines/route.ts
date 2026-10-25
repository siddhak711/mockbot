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

export async function GET(): Promise<Response> {
  const { routines } = await getAppContext();
  if (!routines) return Response.json({ error: "Routines are not available" }, { status: 500 });
  const listed = await routines.list();
  const withRuns: Array<Routine & { runs: RoutineRun[] }> = await Promise.all(
    listed.map(async (routine) => ({ ...routine, runs: await routines.listRuns(routine.id) })),
  );
  return Response.json({ routines: withRuns });
}

export async function POST(request: Request): Promise<Response> {
  const body = await readJson(request);
  if (!body || typeof body !== "object") {
    return Response.json({ error: "Expected JSON body" }, { status: 400 });
  }
  const record = body as { name?: unknown; prompt?: unknown; cron?: unknown; eventName?: unknown };
  const { routines } = await getAppContext();
  if (!routines) return Response.json({ error: "Routines are not available" }, { status: 500 });
  try {
    const routine = await routines.create({
      name: text(record.name),
      prompt: text(record.prompt),
      cron: typeof record.cron === "string" ? record.cron : undefined,
      eventName: typeof record.eventName === "string" ? record.eventName : undefined,
      now: new Date(),
    });
    return Response.json({ routine }, { status: 201 });
  } catch (error) {
    if (error instanceof RoutineInputError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }
}
