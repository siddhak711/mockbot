import { parseEnabled } from "../../../../src/connectors";
import { getAppContext } from "../../../../src/context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, context: RouteContext): Promise<Response> {
  const { id } = await context.params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Expected JSON body" }, { status: 400 });
  }
  const parsed = parseEnabled(body);
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
  const { store } = await getAppContext();
  const connector = await store.setConnectorEnabled(id, parsed.enabled);
  if (!connector) return Response.json({ error: "Connector not found" }, { status: 404 });
  return Response.json({ connector });
}

export async function DELETE(_request: Request, context: RouteContext): Promise<Response> {
  const { id } = await context.params;
  const { store } = await getAppContext();
  const deleted = await store.deleteConnector(id);
  if (!deleted) return Response.json({ error: "Connector not found" }, { status: 404 });
  return new Response(null, { status: 204 });
}
