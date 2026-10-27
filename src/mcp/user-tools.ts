import { noteConnectorOutcome } from "../connectors/runtime";
import type { ConversationStore } from "../store";
import type { ToolRegistry } from "../tools/registry";
import { refreshMcpTools } from "./sync";

/**
 * Hand the caller a copy of the registry with this account's connector tools
 * on it. The shared registry never holds connector tools, so one account's
 * tools cannot reach another account's turn, and turns do not wait on a lock.
 */
export async function withUserTools<T>(
  options: {
    store: ConversationStore;
    tools: ToolRegistry;
    /** Who runs the turn. Connector tools capture it. */
    userId: string;
    /** Signed-in owner whose connectors load. Undefined when auth is off. */
    owner?: string;
    signal?: AbortSignal;
  },
  run: (tools: ToolRegistry) => Promise<T>,
): Promise<T> {
  const { store, tools, userId, owner, signal } = options;
  const turnTools = tools.clone();
  await refreshMcpTools({
    registry: turnTools,
    connectors: await store.listConnectors(owner),
    env: process.env,
    userId,
    signal,
    onToolResult: (connectorId, result) => {
      void noteConnectorOutcome(store, connectorId, result, userId, owner);
    },
    onTools: (connectorId, next) => {
      void store.updateConnectorTools(connectorId, next, undefined, owner);
    },
  });
  return run(turnTools);
}
