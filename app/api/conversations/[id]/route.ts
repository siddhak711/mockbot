import { requireApiUser } from "../../../../src/auth/guard";
import { getAppContext } from "../../../../src/context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const actor = await requireApiUser(request);
  if (!actor.ok) return actor.response;
  const { id } = await context.params;
  const { store } = await getAppContext();
  const found = await store.getConversation(
    id,
    undefined,
    actor.scoped ? actor.user.id : undefined,
  );
  if (!found) return Response.json({ error: "Conversation not found" }, { status: 404 });
  return Response.json(found);
}
