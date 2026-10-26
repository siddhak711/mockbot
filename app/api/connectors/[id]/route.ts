import { requireApiUser } from "../../../../src/auth/guard";
import { parseConnectorPatch, toPublicConnector } from "../../../../src/connectors";
import { composioToolkitForConnector } from "../../../../src/connectors/composio/config";
import { getAppContext } from "../../../../src/context";
import { encryptSecret } from "../../../../src/mcp/vault";

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

export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  const actor = await requireApiUser(request);
  if (!actor.ok) return actor.response;
  const { id } = await context.params;
  const { store } = await getAppContext();
  const existing = (await store.listConnectors()).find((item) => item.id === id) ?? null;
  if (!existing) return Response.json({ error: "Connector not found" }, { status: 404 });
  if (existing.catalogId && composioToolkitForConnector(existing.catalogId, process.env)) {
    await store.deleteComposioConnection(actor.user.id, existing.catalogId);
    if ((await store.countComposioConnections(existing.catalogId)) > 0) {
      return new Response(null, { status: 204 });
    }
  }
  const deleted = await store.deleteConnector(id);
  if (!deleted) return Response.json({ error: "Connector not found" }, { status: 404 });
  return new Response(null, { status: 204 });
}
