import type { ConversationStore } from "../store";
import { composioToolkitForConnector } from "./composio/config";
import { isAuthFailure } from "./policy";

const WINDOW_MS = 5 * 60 * 1000;

export async function noteConnectorOutcome(
  store: ConversationStore,
  connectorId: string,
  result: { isError: boolean; content: string; authExpired?: boolean },
  userId?: string,
): Promise<void> {
  const connectors = await store.listConnectors();
  const connector = connectors.find((item) => item.id === connectorId);
  if (!connector) return;
  if (connector.catalogId && composioToolkitForConnector(connector.catalogId, process.env)) {
    if (userId) await noteComposioOutcome(store, userId, connector.catalogId, result);
    return;
  }
  if (connector.status === "reconnect") return;
  if (!result.isError) {
    if (connector.status === "error")
      await store.setConnectorStatus(connectorId, "connected", null, []);
    return;
  }
  if (result.authExpired || isAuthFailure(result.content)) {
    await store.setConnectorStatus(connectorId, "reconnect", result.content);
    return;
  }
  const now = Date.now();
  const recent = [...(connector.failures ?? []), now].filter((time) => now - time <= WINDOW_MS);
  const status = recent.length >= 3 || connector.status === "error" ? "error" : "connected";
  const detail = status === "error" ? result.content : (connector.statusDetail ?? null);
  await store.setConnectorStatus(connectorId, status, detail, recent);
}

async function noteComposioOutcome(
  store: ConversationStore,
  userId: string,
  catalogId: string,
  result: { isError: boolean; content: string; authExpired?: boolean },
): Promise<void> {
  const connection = await store.getComposioConnection(userId, catalogId);
  if (!connection || connection.status === "reconnect") return;
  if (!result.isError || !(result.authExpired || isAuthFailure(result.content))) return;
  await store.upsertComposioConnection({
    userId,
    catalogId,
    toolkit: connection.toolkit,
    connectedAccountId: connection.connectedAccountId,
    accountLabel: connection.accountLabel,
    status: "reconnect",
  });
}
