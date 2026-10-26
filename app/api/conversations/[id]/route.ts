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
  const title =
    body && typeof body === "object" && typeof (body as { title?: unknown }).title === "string"
      ? (body as { title: string }).title.trim()
      : "";
  if (!title) return Response.json({ error: "Title is required" }, { status: 400 });
  if (title.length > 120) {
    return Response.json({ error: "Title is too long" }, { status: 400 });
  }
  const { store } = await getAppContext();
  const conversation = await store.renameConversation(
    id,
    title,
    actor.scoped ? actor.user.id : undefined,
  );
  if (!conversation) return Response.json({ error: "Conversation not found" }, { status: 404 });
  return Response.json({ conversation });
}

export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  const actor = await requireApiUser(request);
  if (!actor.ok) return actor.response;
  const { id } = await context.params;
  const { store } = await getAppContext();
  const deleted = await store.deleteConversation(id, actor.scoped ? actor.user.id : undefined);
  if (!deleted) return Response.json({ error: "Conversation not found" }, { status: 404 });
  return new Response(null, { status: 204 });
}
