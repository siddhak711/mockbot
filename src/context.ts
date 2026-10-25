import { AgentDirectory } from "./agents/directory";
import { withAgentMock } from "./agents/mock-script";
import { NoteMemory, defaultComputer, defaultConnector } from "./agents/ports";
import type { AgentMemoryPort, ComputerPort, ConnectorPort } from "./agents/types";
import { selectProvider, type LlmProvider } from "./llm";
import { ConversationStore } from "./store";
import { ApprovalGate } from "./tools/approval";
import { createDefaultTools } from "./tools/builtins";
import type { ToolRegistry } from "./tools/registry";

export type AppContext = {
  store: ConversationStore;
  provider: LlmProvider;
  tools: ToolRegistry;
  approvals: ApprovalGate;
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

export function setAppContext(context: {
  store: ConversationStore;
  provider: LlmProvider;
  tools?: ToolRegistry;
  approvals?: ApprovalGate;
  agents?: AgentDirectory;
  memory?: AgentMemoryPort;
  computer?: ComputerPort;
  connector?: ConnectorPort;
}): void {
  current = {
    store: context.store,
    provider: context.provider,
    tools: context.tools ?? createDefaultTools({}),
    approvals: context.approvals ?? new ApprovalGate(),
    agents: context.agents,
    memory: context.memory,
    computer: context.computer,
    connector: context.connector,
  };
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
      tools: createDefaultTools(process.env),
      approvals: new ApprovalGate(),
    };
  }
  return current;
}
