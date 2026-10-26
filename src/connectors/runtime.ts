import type { ConversationStore } from "../store";
import { isAuthFailure } from "./policy";

const WINDOW_MS = 5 * 60 * 1000;

export async function noteConnectorOutcome(
  store: ConversationStore,
  connectorId: string,
  result: { isError: boolean; content: string },
): Promise<void> {
  const connectors = await store.listConnectors();
  const connector = connectors.find((item) => item.id === connectorId);
  if (!connector || connector.status === "reconnect") return;
  if (!result.isError) {
    if (connector.status === "error")
      await store.setConnectorStatus(connectorId, "connected", null, []);
    return;
  }
  if (isAuthFailure(result.content)) {
    await store.setConnectorStatus(connectorId, "reconnect", result.content);
    return;
  }
  const now = Date.now();
  const recent = [...(connector.failures ?? []), now].filter((time) => now - time <= WINDOW_MS);
  const status = recent.length >= 3 || connector.status === "error" ? "error" : "connected";
  const detail = status === "error" ? result.content : (connector.statusDetail ?? null);
  await store.setConnectorStatus(connectorId, status, detail, recent);
}
