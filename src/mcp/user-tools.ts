import { noteConnectorOutcome } from "../connectors/runtime";
import type { ConversationStore } from "../store";
import type { ToolRegistry } from "../tools/registry";
import { refreshMcpTools, withFreshTools } from "./sync";

/**
 * Refresh connector tools for the signed-in user, then hand the caller a clone
 * of the registry. Connector tools capture the user they were listed for, so a
 * turn must never run on a registry another user refreshed.
 */
export function withUserTools<T>(
  options: {
    store: ConversationStore;
    tools: ToolRegistry;
    userId: string;
    signal?: AbortSignal;
  },
  run: (tools: ToolRegistry) => Promise<T>,
): Promise<T> {
  const { store, tools, userId, signal } = options;
  return withFreshTools(async () => {
    const connectors = await store.listConnectors();
    await refreshMcpTools({
      registry: tools,
      connectors,
      env: process.env,
      userId,
      signal,
      onToolResult: (connectorId, result) => {
        void noteConnectorOutcome(store, connectorId, result, userId);
      },
      onTools: (connectorId, next) => {
        void store.updateConnectorTools(connectorId, next);
      },
    });
    return run(tools.clone());
  });
}
