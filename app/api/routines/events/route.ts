import { getAppContext } from "../../../../src/context";
import { RoutineInputError } from "../../../../src/routines/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Expected JSON body" }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return Response.json({ error: "Expected JSON body" }, { status: 400 });
  }
  const record = body as { name?: unknown; payload?: unknown };
  const { routines } = await getAppContext();
  if (!routines) return Response.json({ error: "Routines are not available" }, { status: 500 });
  try {
    const result = await routines.recordEvent({
      name: typeof record.name === "string" ? record.name : "",
      payload: typeof record.payload === "string" ? record.payload : null,
      now: new Date(),
    });
    return Response.json(result, { status: 201 });
  } catch (error) {
    if (error instanceof RoutineInputError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }
}
