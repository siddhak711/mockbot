import { AgentDirectory } from "./agents/directory";
import { withAgentMock } from "./agents/mock-script";
import { NoteMemory, defaultComputer, defaultConnector } from "./agents/ports";
import type { AgentMemoryPort, ComputerPort, ConnectorPort } from "./agents/types";
import { selectProvider, type LlmProvider } from "./llm";
import { RoutineStore } from "./routines/store";
import { ConversationStore } from "./store";
import { ApprovalGate } from "./tools/approval";
import { createDefaultTools } from "./tools/builtins";
import { registerMemoryTools, type ToolRegistry } from "./tools/registry";

export type AppContext = {
  store: ConversationStore;
  provider: LlmProvider;
  tools: ToolRegistry;
  approvals: ApprovalGate;
  routines?: RoutineStore;
  agents?: AgentDirectory;
  memory?: AgentMemoryPort;
  computer?: ComputerPort;
  connector?: ConnectorPort;
};

const GLOBAL_KEY = "__mockbotAppContext";

type Slot = {
  current?: AppContext;
  opening?: Promise<AppContext>;
};

function slot(): Slot {
  const g = globalThis as typeof globalThis & { [GLOBAL_KEY]?: Slot };
  if (!g[GLOBAL_KEY]) g[GLOBAL_KEY] = {};
  return g[GLOBAL_KEY];
}

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
  routines?: RoutineStore;
  agents?: AgentDirectory;
  memory?: AgentMemoryPort;
  computer?: ComputerPort;
  connector?: ConnectorPort;
}): void {
  const tools = context.tools ?? createDefaultTools({});
  if (!context.tools) registerMemoryTools(tools, context.store);
  current = {
    store: context.store,
    provider: context.provider,
    tools,
    approvals: context.approvals ?? new ApprovalGate(),
    routines: context.routines,
    agents: context.agents,
    memory: context.memory,
    computer: context.computer,
    connector: context.connector,
  };
  const shared = slot();
  shared.current = current;
  shared.opening = undefined;
}

export async function resetAppContext(): Promise<void> {
  const shared = slot();
  const existing = current ?? shared.current;
  current = undefined;
  shared.current = undefined;
  shared.opening = undefined;
  if (existing) await existing.store.close();
}

export async function getAppContext(): Promise<AppContext> {
  if (current) return current;
  const shared = slot();
  if (shared.current) {
    current = shared.current;
    return current;
  }
  if (!shared.opening) {
    shared.opening = ConversationStore.connect(process.env).then(async (store) => {
      const tools = createDefaultTools(process.env);
      registerMemoryTools(tools, store);
      const agents = await AgentDirectory.attach(store);
      return {
        store,
        provider: withAgentMock(selectProvider(process.env)),
        tools,
        agents,
        memory: new NoteMemory(agents),
        computer: defaultComputer,
        connector: defaultConnector,
        approvals: new ApprovalGate(),
        routines: await RoutineStore.attach(store),
      };
    });
  }
  try {
    const opened = await shared.opening;
    shared.current = opened;
    shared.opening = undefined;
    current = opened;
    return opened;
  } catch (error) {
    shared.opening = undefined;
    throw error;
  }
}
