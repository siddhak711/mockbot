import { parseConnectorPatch, toPublicConnector } from "../../../../src/connectors";
import { getAppContext } from "../../../../src/context";
import { encryptSecret } from "../../../../src/mcp/vault";

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
  const parsed = parseConnectorPatch(body);
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
  const { store } = await getAppContext();
  let connector = (await store.listConnectors()).find((item) => item.id === id) ?? null;
  if (!connector) return Response.json({ error: "Connector not found" }, { status: 404 });
  if (parsed.reconnected) {
    connector = await store.setConnectorStatus(id, "connected", null, []);
    if (!connector) return Response.json({ error: "Connector not found" }, { status: 404 });
    if (parsed.apiKey) {
      connector = await store.setConnectorSecret(id, await encryptSecret(parsed.apiKey));
      if (!connector) return Response.json({ error: "Connector not found" }, { status: 404 });
    }
  }
  if (typeof parsed.enabled === "boolean") {
    connector = await store.setConnectorEnabled(id, parsed.enabled);
    if (!connector) return Response.json({ error: "Connector not found" }, { status: 404 });
  }
  return Response.json({ connector: toPublicConnector(connector) });
}

export async function DELETE(_request: Request, context: RouteContext): Promise<Response> {
  const { id } = await context.params;
  const { store } = await getAppContext();
  const deleted = await store.deleteConnector(id);
  if (!deleted) return Response.json({ error: "Connector not found" }, { status: 404 });
  return new Response(null, { status: 204 });
}
