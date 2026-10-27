import type { ConversationStore } from "../store";
import { composioToolkitForConnector } from "./composio/config";
import { isAuthFailure } from "./policy";

const WINDOW_MS = 5 * 60 * 1000;

export async function noteConnectorOutcome(
  store: ConversationStore,
  connectorId: string,
  result: { isError: boolean; content: string; authExpired?: boolean },
  userId?: string,
  /** Signed-in owner. A failure pauses only that account's connector. */
  ownerId?: string | null,
): Promise<void> {
  const connector = await store.getConnector(connectorId, ownerId);
  if (!connector) return;
  if (connector.catalogId && composioToolkitForConnector(connector.catalogId, process.env)) {
    if (userId) await noteComposioOutcome(store, userId, connector.catalogId, result);
    return;
  }
  if (connector.status === "reconnect") return;
  if (!result.isError) {
    if (connector.status === "error")
      await store.setConnectorStatus(connectorId, "connected", null, [], ownerId);
    return;
  }
  if (result.authExpired || isAuthFailure(result.content)) {
    await store.setConnectorStatus(connectorId, "reconnect", result.content, undefined, ownerId);
    return;
  }
  const now = Date.now();
  const recent = [...(connector.failures ?? []), now].filter((time) => now - time <= WINDOW_MS);
  const status = recent.length >= 3 || connector.status === "error" ? "error" : "connected";
  const detail = status === "error" ? result.content : (connector.statusDetail ?? null);
  await store.setConnectorStatus(connectorId, status, detail, recent, ownerId);
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
