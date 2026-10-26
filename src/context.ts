import { AgentDirectory } from "./agents/directory";
import { withAgentMock } from "./agents/mock-script";
import { NoteMemory, defaultComputer, defaultConnector } from "./agents/ports";
import type { AgentMemoryPort, ComputerPort, ConnectorPort } from "./agents/types";
import { selectProvider, type LlmProvider } from "./llm";
import { RoutineStore } from "./routines/store";
import { openComputer } from "./sandbox/open";
import type { ComputerSupervisor } from "./sandbox/supervisor";
import { createComputerTools } from "./sandbox/tools";
import { SandboxTurnProvider } from "./sandbox/turn";
import { ConversationStore } from "./store";
import { AskGate } from "./tools/ask-user";
import { ApprovalGate } from "./tools/approval";
import { createDefaultTools } from "./tools/builtins";
import { registerMemoryTools, type ToolRegistry } from "./tools/registry";

export type AppContext = {
  store: ConversationStore;
  provider: LlmProvider;
  tools: ToolRegistry;
  approvals: ApprovalGate;
  asks: AskGate;
  sandbox?: ComputerSupervisor;
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

export function registerComputerTools(registry: ToolRegistry, sandbox: ComputerSupervisor): void {
  for (const tool of createComputerTools(sandbox)) {
    if (!registry.get(tool.name)) registry.register(tool);
  }
}

export function setAppContext(context: {
  store: ConversationStore;
  provider: LlmProvider;
  tools?: ToolRegistry;
  approvals?: ApprovalGate;
  asks?: AskGate;
  sandbox?: ComputerSupervisor;
  routines?: RoutineStore;
  agents?: AgentDirectory;
  memory?: AgentMemoryPort;
  computer?: ComputerPort;
  connector?: ConnectorPort;
}): void {
  const tools = context.tools ?? createDefaultTools({});
  if (!context.tools) registerMemoryTools(tools, context.store);
  if (context.sandbox) registerComputerTools(tools, context.sandbox);
  current = {
    store: context.store,
    provider: context.provider,
    tools,
    approvals: context.approvals ?? new ApprovalGate(),
    asks: context.asks ?? new AskGate(),
    sandbox: context.sandbox,
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
  if (!existing) return;
  await existing.sandbox?.close();
  await existing.store.close();
}

function streamDelay(env: Record<string, string | undefined>): number {
  const raw = env.MOCK_STREAM_DELAY_MS?.trim();
  if (!raw) return 60;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 60;
}

export async function getAppContext(): Promise<AppContext> {
  if (current) return current;
  const shared = slot();
  if (shared.current) {
    current = shared.current;
    return current;
  }
  if (!shared.opening) {
    shared.opening = openApp();
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

async function openApp(): Promise<AppContext> {
  const store = await ConversationStore.connect(process.env);
  let sandbox: ComputerSupervisor | undefined;
  try {
    sandbox = await openComputer({ env: process.env });
    const tools = createDefaultTools(process.env);
    registerMemoryTools(tools, store);
    registerComputerTools(tools, sandbox);
    const agents = await AgentDirectory.attach(store);
    const inner = withAgentMock(selectProvider(process.env));
    return {
      store,
      sandbox,
      tools,
      approvals: new ApprovalGate(),
      asks: new AskGate(),
      agents,
      memory: new NoteMemory(agents),
      computer: defaultComputer,
      connector: defaultConnector,
      routines: await RoutineStore.attach(store),
      provider: new SandboxTurnProvider({
        inner,
        delayMs: inner.id === "mock" ? streamDelay(process.env) : 0,
      }),
    };
  } catch (error) {
    await sandbox?.close();
    await store.close();
    throw error;
  }
}
