import { requireApiUser } from "../../../../src/auth/guard";
import {
  parseConnectorPatch,
  toPublicConnector,
  type ConnectorRecord,
} from "../../../../src/connectors";
import { composioToolkitForConnector } from "../../../../src/connectors/composio/config";
import { PASTED_OAUTH_UNSUPPORTED_MESSAGE } from "../../../../src/connectors/policy";
import { probeConnector } from "../../../../src/connectors/probe";
import { getAppContext } from "../../../../src/context";
import { resolveConnectorSecret } from "../../../../src/mcp/secrets";
import { encryptSecret } from "../../../../src/mcp/vault";
import { isAbortError } from "../../../../src/tools/http";

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
  const owner = actor.scoped ? actor.user.id : undefined;
  let connector = await store.getConnector(id, owner);
  if (!connector) return Response.json({ error: "Connector not found" }, { status: 404 });
  if (parsed.reconnected) {
    const refused = await verifyReconnect(connector, parsed.apiKey, request.signal);
    if (refused) return refused;
    connector = await store.setConnectorStatus(id, "connected", null, [], owner);
    if (!connector) return Response.json({ error: "Connector not found" }, { status: 404 });
    if (parsed.apiKey) {
      connector = await store.setConnectorSecret(id, await encryptSecret(parsed.apiKey), owner);
      if (!connector) return Response.json({ error: "Connector not found" }, { status: 404 });
    }
  }
  if (typeof parsed.enabled === "boolean") {
    connector = await store.setConnectorEnabled(id, parsed.enabled, owner);
    if (!connector) return Response.json({ error: "Connector not found" }, { status: 404 });
  }
  return Response.json({ connector: toPublicConnector(connector) });
}

export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  const actor = await requireApiUser(request);
  if (!actor.ok) return actor.response;
  const { id } = await context.params;
  const { store } = await getAppContext();
  const owner = actor.scoped ? actor.user.id : undefined;
  const existing = await store.getConnector(id, owner);
  if (!existing) return Response.json({ error: "Connector not found" }, { status: 404 });
  if (existing.catalogId && composioToolkitForConnector(existing.catalogId, process.env)) {
    await store.deleteComposioConnection(actor.user.id, existing.catalogId);
    // A row without an owner is shared by every linked account. It stays until
    // the last link is removed. An owned row goes with its owner's link.
    if (!existing.userId && (await store.countComposioConnections(existing.catalogId)) > 0) {
      return new Response(null, { status: 204 });
    }
  }
  const deleted = await store.deleteConnector(id, owner);
  if (!deleted) return Response.json({ error: "Connector not found" }, { status: 404 });
  return new Response(null, { status: 204 });
}

/**
 * Reconnect only after the server accepts the connector again: the new key
 * when one is given, the stored secret otherwise. Returns the error response,
 * or null when the probe succeeded.
 */
async function verifyReconnect(
  connector: ConnectorRecord,
  apiKey: string | undefined,
  signal: AbortSignal,
): Promise<Response | null> {
  if (connector.catalogId) {
    return Response.json(
      { error: `Reconnect ${connector.name} by signing in again.` },
      { status: 400 },
    );
  }
  if (connector.authType === "oauth") {
    return Response.json(
      { error: PASTED_OAUTH_UNSUPPORTED_MESSAGE, code: "auth" },
      { status: 400 },
    );
  }
  let key = apiKey;
  if (!key && connector.secretCipher) {
    const stored = await resolveConnectorSecret(connector, process.env);
    if (!stored.ok) return Response.json({ error: stored.error }, { status: 400 });
    key = stored.secret;
  }
  try {
    const probe = await probeConnector({
      transport: connector.transport,
      target: connector.target,
      name: connector.name,
      secretRef: key ? null : connector.secretRef,
      apiKey: key,
      signal,
    });
    if (probe.ok) return null;
    return Response.json({ error: probe.message, code: probe.code }, { status: 400 });
  } catch (error) {
    if (signal.aborted || isAbortError(error)) {
      return Response.json({ error: "The connection was cancelled." }, { status: 400 });
    }
    return Response.json({ error: "Could not reach the MCP server." }, { status: 400 });
  }
}
