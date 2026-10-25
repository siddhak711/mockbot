import { parseConnectorInput, type ConnectorRecord } from "../../../src/connectors";
import { getAppContext } from "../../../src/context";
import { McpClientError } from "../../../src/mcp/client";
import { previewMcpTools } from "../../../src/mcp/sync";
import { resolveSecret } from "../../../src/mcp/secrets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const { store } = await getAppContext();
  const connectors = await store.listConnectors();
  return Response.json({ connectors });
}

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Expected JSON body" }, { status: 400 });
  }
  const parsed = parseConnectorInput(body);
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });

  const resolved = resolveSecret(parsed.value.secretRef, process.env);
  if (!resolved.ok) return Response.json({ error: resolved.error }, { status: 400 });

  const { store, tools: registry } = await getAppContext();
  const existing = await store.listConnectors();
  const draft: ConnectorRecord = {
    id: crypto.randomUUID(),
    ...parsed.value,
    enabled: true,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
  try {
    const tools = await previewMcpTools(
      draft,
      [...existing, draft],
      process.env,
      registry,
      request.signal,
    );
    const connector = await store.createConnector({ id: draft.id, ...parsed.value });
    return Response.json({ connector, tools }, { status: 201 });
  } catch (error) {
    if (request.signal.aborted) {
      return Response.json({ error: "The connection was cancelled." }, { status: 400 });
    }
    const message =
      error instanceof McpClientError ? error.message : "Could not reach the MCP server.";
    return Response.json({ error: message }, { status: 400 });
  }
}
