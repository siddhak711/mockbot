import { randomBytes } from "node:crypto";
import { catalogById, catalogIsWired } from "../../../src/connectors/catalog";
import { composioToolkitForConnector } from "../../../src/connectors/composio/config";
import { resolveToolSettings, type DiscoveredTool } from "../../../src/connectors/policy";
import { probeConnector } from "../../../src/connectors/probe";
import {
  parseConnectorInput,
  toPublicConnector,
  type ConnectorRecord,
} from "../../../src/connectors";
import { requireApiUser } from "../../../src/auth/guard";
import { getAppContext } from "../../../src/context";
import { assignMcpToolNames } from "../../../src/mcp/sync";
import { redactSecrets, resolveSecret } from "../../../src/mcp/secrets";
import { encryptSecret } from "../../../src/mcp/vault";
import { isAbortError } from "../../../src/tools/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request?: Request): Promise<Response> {
  const actor = await requireApiUser(request);
  if (!actor.ok) return actor.response;
  const { store } = await getAppContext();
  const connections = await store.listComposioConnections(actor.user.id);
  const byCatalog = new Map(connections.map((item) => [item.catalogId, item]));
  const connectors = (await store.listConnectors()).map((record) => {
    const visible = toPublicConnector(record);
    if (!record.catalogId || !composioToolkitForConnector(record.catalogId, process.env)) {
      return visible;
    }
    const connection = byCatalog.get(record.catalogId);
    const linked = connection?.status === "connected" || connection?.status === "reconnect";
    if (!connection || !linked) {
      return {
        ...visible,
        accountLabel: null,
        status: "not connected" as const,
        statusDetail: null,
      };
    }
    return {
      ...visible,
      accountLabel: connection.accountLabel,
      status: connection.status,
      statusDetail: connection.status === "reconnect" ? "Tools are paused." : null,
    };
  });
  return Response.json({ connectors });
}

export async function POST(request: Request): Promise<Response> {
  const actor = await requireApiUser(request);
  if (!actor.ok) return actor.response;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Expected JSON body" }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return Response.json({ error: "Expected JSON body" }, { status: 400 });
  }
  const record = body as {
    catalogId?: unknown;
    accountLabel?: unknown;
    apiKey?: unknown;
    tools?: unknown;
    oauth?: unknown;
  };
  if (typeof record.catalogId === "string" && record.catalogId.trim()) {
    try {
      return await createCatalogConnector(record.catalogId.trim(), record.accountLabel);
    } catch (error) {
      return connectorCreateFailure(error, request.signal);
    }
  }

  const parsed = parseConnectorInput(body);
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
  const apiKey = typeof record.apiKey === "string" ? record.apiKey : "";
  if (apiKey.length > 2_000)
    return Response.json({ error: "API key is too long." }, { status: 400 });

  const resolved = apiKey
    ? { ok: true as const, secret: apiKey }
    : resolveSecret(parsed.value.secretRef, process.env);
  if (!resolved.ok) return Response.json({ error: resolved.error }, { status: 400 });
  const { store, tools: registry } = await getAppContext();
  const existing = await store.listConnectors();
  const draft: ConnectorRecord = {
    id: crypto.randomUUID(),
    name: parsed.value.name,
    transport: parsed.value.transport,
    target: parsed.value.target,
    secretRef: apiKey ? null : parsed.value.secretRef,
    enabled: true,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
  const listing = assignMcpToolNames({
    registry,
    connectors: [...existing, draft],
    env: process.env,
    signal: request.signal,
  });
  let probe: Awaited<ReturnType<typeof probeConnector>>;
  try {
    probe = await probeConnector({
      transport: parsed.value.transport,
      target: parsed.value.target,
      name: parsed.value.name,
      secretRef: apiKey ? null : parsed.value.secretRef,
      apiKey: apiKey || undefined,
      signal: request.signal,
    });
  } catch (error) {
    await listing.catch(() => undefined);
    return probeFailure(error, request.signal);
  }
  try {
    const listed = await listing;
    const cancelled =
      request.signal.aborted || listed.batches.some((batch) => isAbortError(batch.error));
    if (cancelled) {
      return Response.json({ error: "The connection was cancelled." }, { status: 400 });
    }
    if (!probe.ok) {
      if (record.oauth === true && probe.code === "auth" && probe.auth === "oauth") {
        const connector = await store.createConnector({
          ...parsed.value,
          secretRef: null,
          secretCipher: await encryptSecret(randomBytes(32).toString("base64url")),
          authType: "oauth",
          tools: {},
        });
        return Response.json(
          { connector: toPublicConnector(connector), tools: [] },
          { status: 201 },
        );
      }
      return Response.json({ error: probe.message, code: probe.code }, { status: 400 });
    }
    const provided = providedTools(record.tools);
    if (provided === "invalid") {
      return Response.json({ error: "tools must be an object." }, { status: 400 });
    }
    const secrets = resolved.secret ? [resolved.secret] : [];
    const discovered = probe.tools.map((tool) => redactDiscovered(tool, secrets));
    const settings = resolveToolSettings(
      discovered,
      provided ?? undefined,
      provided ? "defaults" : "legacy",
    );
    const connector = await store.createConnector({
      ...parsed.value,
      secretRef: apiKey ? null : parsed.value.secretRef,
      secretCipher: apiKey ? await encryptSecret(apiKey) : null,
      authType: probe.auth,
      tools: settings,
    });
    const tools = probe.tools
      .filter((tool) => tool.name && settings[tool.name]?.enabled)
      .map((tool) => ({ name: tool.name, remoteName: tool.name }));
    return Response.json({ connector: toPublicConnector(connector), tools }, { status: 201 });
  } catch (error) {
    await listing.catch(() => undefined);
    return connectorCreateFailure(error, request.signal);
  }
}

function createCatalogConnector(catalogId: string, _accountLabel: unknown): Response {
  const entry = catalogById(catalogId);
  if (!entry) return Response.json({ error: "Unknown connector." }, { status: 400 });
  if (!catalogIsWired(entry)) {
    return Response.json({ error: `${entry.name} is not available yet.` }, { status: 400 });
  }
  return Response.json(
    {
      error: `Connect ${entry.name} with Composio OAuth. Start at /api/connectors/oauth/start.`,
    },
    { status: 400 },
  );
}

function connectorCreateFailure(error: unknown, signal: AbortSignal): Response {
  if (signal.aborted || isAbortError(error)) {
    return Response.json({ error: "The connection was cancelled." }, { status: 400 });
  }
  return Response.json({ error: connectorErrorMessage(error) }, { status: 500 });
}

function probeFailure(error: unknown, signal: AbortSignal): Response {
  if (signal.aborted || isAbortError(error)) {
    return Response.json({ error: "The connection was cancelled." }, { status: 400 });
  }
  const message = error instanceof Error ? error.message : "";
  if (/CONNECTOR_SECRET_KEY/i.test(message)) {
    return Response.json({ error: connectorErrorMessage(error) }, { status: 500 });
  }
  return Response.json({ error: "Could not reach the MCP server." }, { status: 400 });
}

function connectorErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim().slice(0, 500);
  return "Could not create the connector.";
}

function redactDiscovered(tool: DiscoveredTool, secrets: readonly string[]): DiscoveredTool {
  return { ...tool, description: redactSecrets(tool.description, secrets) };
}

function providedTools(
  value: unknown,
): Record<string, { enabled?: boolean; approval?: unknown }> | null | "invalid" {
  if (value == null) return null;
  if (typeof value !== "object" || Array.isArray(value)) return "invalid";
  return value as Record<string, { enabled?: boolean; approval?: unknown }>;
}
