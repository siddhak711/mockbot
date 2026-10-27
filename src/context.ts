import { AgentDirectory } from "./agents/directory";
import { withAgentMock } from "./agents/mock-script";
import { NoteMemory, defaultComputer, defaultConnector } from "./agents/ports";
import type { AgentMemoryPort, ComputerPort, ConnectorPort } from "./agents/types";
import { selectProvider, type LlmProvider } from "./llm";
import { loadRouterConfig, RoutingProvider } from "./model-router";
import { RoutineStore } from "./routines/store";
import { sandboxBrowseTool } from "./browser/open";
import { BROWSE_TOOL_NAME, browseTool } from "./browser/tool";
import { siteToolsForApp } from "./site-tools/tools";
import { openComputer, sandboxUnavailableReason } from "./sandbox/open";
import type { ComputerSupervisor } from "./sandbox/supervisor";
import { createComputerTools, createUnavailableComputerTools } from "./sandbox/tools";
import { SandboxTurnProvider } from "./sandbox/turn";
import { ConversationStore } from "./store";
import { AskGate } from "./tools/ask-user";
import { ApprovalGate } from "./tools/approval";
import { PlanGate } from "./tools/plan";
import { createDefaultTools } from "./tools/builtins";
import { registerMemoryTools, type ToolRegistry } from "./tools/registry";

export type AppContext = {
  store: ConversationStore;
  provider: LlmProvider;
  tools: ToolRegistry;
  approvals: ApprovalGate;
  asks: AskGate;
  plans: PlanGate;
  sandbox?: ComputerSupervisor;
  /** Why the sandbox did not open, shown in the computer pane and tool results. */
  sandboxError?: string;
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

export function registerComputerTools(
  registry: ToolRegistry,
  sandbox: ComputerSupervisor,
  env: Record<string, string | undefined> = {},
): void {
  for (const tool of createComputerTools(sandbox)) {
    if (!registry.get(tool.name)) registry.register(tool);
  }
  if (!registry.get(BROWSE_TOOL_NAME)) registry.register(sandboxBrowseTool(sandbox, env));
}

export function registerSiteTools(
  registry: ToolRegistry,
  store: ConversationStore,
  sandbox?: ComputerSupervisor,
  env: Record<string, string | undefined> = {},
): void {
  for (const tool of siteToolsForApp({ store, sandbox, env })) {
    if (!registry.get(tool.name)) registry.register(tool);
  }
}

export function registerUnavailableComputerTools(registry: ToolRegistry, reason: string): void {
  for (const tool of createUnavailableComputerTools(reason)) {
    if (!registry.get(tool.name)) registry.register(tool);
  }
  // browse runs in the sandbox too, so it fails with the same reason.
  if (!registry.get(BROWSE_TOOL_NAME)) {
    registry.register(
      browseTool({ driver: () => null, unavailable: `browse is unavailable: ${reason}` }),
    );
  }
}

export function setAppContext(context: {
  store: ConversationStore;
  provider: LlmProvider;
  tools?: ToolRegistry;
  approvals?: ApprovalGate;
  asks?: AskGate;
  plans?: PlanGate;
  sandbox?: ComputerSupervisor;
  sandboxError?: string;
  routines?: RoutineStore;
  agents?: AgentDirectory;
  memory?: AgentMemoryPort;
  computer?: ComputerPort;
  connector?: ConnectorPort;
}): void {
  const tools = context.tools ?? createDefaultTools(process.env);
  if (!context.tools) registerMemoryTools(tools, context.store);
  if (context.sandbox) registerComputerTools(tools, context.sandbox);
  else if (context.sandboxError) registerUnavailableComputerTools(tools, context.sandboxError);
  registerSiteTools(tools, context.store, context.sandbox, process.env);
  current = {
    store: context.store,
    provider: context.provider,
    tools,
    approvals: context.approvals ?? new ApprovalGate(),
    asks: context.asks ?? new AskGate(),
    plans: context.plans ?? new PlanGate(),
    sandbox: context.sandbox,
    sandboxError: context.sandboxError,
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
  const sandboxError = sandboxUnavailableReason(process.env) ?? undefined;
  try {
    if (!sandboxError) sandbox = await openComputer({ env: process.env });
    const tools = createDefaultTools(process.env);
    registerMemoryTools(tools, store);
    if (sandbox) registerComputerTools(tools, sandbox, process.env);
    else registerUnavailableComputerTools(tools, sandboxError ?? "The sandbox is not available.");
    registerSiteTools(tools, store, sandbox, process.env);
    const agents = await AgentDirectory.attach(store);
    const inner = new RoutingProvider({
      inner: withAgentMock(selectProvider(process.env)),
      config: loadRouterConfig(process.env),
      db: store.connection,
    });
    return {
      store,
      sandbox,
      sandboxError,
      tools,
      approvals: new ApprovalGate(),
      asks: new AskGate(),
      plans: new PlanGate(),
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
