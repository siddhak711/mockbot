import { requireApiUser } from "../../../../../src/auth/guard";
import { CATALOG } from "../../../../../src/connectors/catalog";
import { getComposioBroker } from "../../../../../src/connectors/composio/broker";
import { nativeCatalogOAuthEnabled } from "../../../../../src/connectors/composio/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const actor = await requireApiUser(request);
  if (!actor.ok) return actor.response;
  try {
    const broker = await getComposioBroker(process.env);
    const toolkits = await broker.listToolkits();
    const native = nativeCatalogOAuthEnabled(process.env);
    return Response.json({
      toolkits,
      catalog: CATALOG.map((entry) => ({
        id: entry.id,
        name: entry.name,
        toolkit: entry.composio?.toolkit ?? null,
        enabled: Boolean(entry.composio?.enabled) && !native,
      })),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message.trim().slice(0, 500) : "";
    return Response.json(
      { error: message || "Could not list Composio apps." },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }
}
