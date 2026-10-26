import { parseToolSettingsBody, toPublicConnector, type ConnectorToolSetting } from "../../../../../src/connectors";
import { classifyToolRisk } from "../../../../../src/connectors/policy";
import { getAppContext } from "../../../../../src/context";

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
  const parsed = parseToolSettingsBody(body);
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
  const { store } = await getAppContext();
  const existing = (await store.listConnectors()).find((connector) => connector.id === id);
  if (!existing) return Response.json({ error: "Connector not found" }, { status: 404 });
  const next: Record<string, ConnectorToolSetting> = { ...(existing.tools ?? {}) };
  for (const [name, patch] of Object.entries(parsed.tools)) {
    const current = next[name];
    if (current?.skipped) continue;
    const risk = current?.risk ?? classifyToolRisk(name);
    let approval = patch.approval ?? current?.approval ?? (risk === "read" ? "auto" : "ask");
    if (risk === "read") approval = "auto";
    if (risk === "destructive") approval = "ask";
    next[name] = {
      enabled: patch.enabled,
      approval,
      risk,
      description: current?.description ?? "",
      skipped: false,
    };
  }
  const seen = parsed.markSeen ? Object.keys(next) : undefined;
  const connector = await store.updateConnectorTools(id, next, seen);
  if (!connector) return Response.json({ error: "Connector not found" }, { status: 404 });
  return Response.json({ connector: toPublicConnector(connector) });
}
