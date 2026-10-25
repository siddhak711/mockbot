import { AgentDirectory } from "./agents/directory";
import { withAgentMock } from "./agents/mock-script";
import { NoteMemory, defaultComputer, defaultConnector } from "./agents/ports";
import type { AgentMemoryPort, ComputerPort, ConnectorPort } from "./agents/types";
import { selectProvider, type LlmProvider } from "./llm";
import { ConversationStore } from "./store";

export type AppContext = {
  store: ConversationStore;
  provider: LlmProvider;
  agents?: AgentDirectory;
  memory?: AgentMemoryPort;
  computer?: ComputerPort;
  connector?: ConnectorPort;
};

export async function getAgents(context: AppContext): Promise<AgentDirectory> {
  if (!context.agents) context.agents = await AgentDirectory.attach(context.store);
  return context.agents;
}

let current: AppContext | undefined;

export function setAppContext(context: AppContext): void {
  current = context;
}

export async function resetAppContext(): Promise<void> {
  const existing = current;
  current = undefined;
  if (existing) await existing.store.close();
}

export async function getAppContext(): Promise<AppContext> {
  if (!current) {
    const dataDir = process.env.DATA_DIR?.trim() || ".data/pglite";
    const store = await ConversationStore.open(dataDir);
    const agents = await AgentDirectory.attach(store);
    current = {
      store,
      provider: withAgentMock(selectProvider(process.env)),
      agents,
      memory: new NoteMemory(agents),
      computer: defaultComputer,
      connector: defaultConnector,
    };
  }
  return current;
}
