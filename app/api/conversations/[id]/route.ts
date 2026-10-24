import { getAppContext } from "../../../../src/context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: RouteContext): Promise<Response> {
  const { id } = await context.params;
  const { store } = await getAppContext();
  const found = await store.getConversation(id);
  if (!found) return Response.json({ error: "Conversation not found" }, { status: 404 });
  return Response.json(found);
}

export async function PATCH(request: Request, context: RouteContext): Promise<Response> {
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
  const conversation = await store.renameConversation(id, title);
  if (!conversation) return Response.json({ error: "Conversation not found" }, { status: 404 });
  return Response.json({ conversation });
}

export async function DELETE(_request: Request, context: RouteContext): Promise<Response> {
  const { id } = await context.params;
  const { store } = await getAppContext();
  const deleted = await store.deleteConversation(id);
  if (!deleted) return Response.json({ error: "Conversation not found" }, { status: 404 });
  return new Response(null, { status: 204 });
}
