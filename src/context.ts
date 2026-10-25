import { selectProvider, type LlmProvider } from "./llm";
import { openComputer } from "./sandbox/open";
import type { ComputerSupervisor } from "./sandbox/supervisor";
import { createComputerTools } from "./sandbox/tools";
import { SandboxTurnProvider } from "./sandbox/turn";
import { ConversationStore } from "./store";
import { ApprovalGate } from "./tools/approval";
import { createDefaultTools } from "./tools/builtins";
import type { ToolRegistry } from "./tools/registry";

export type AppContext = {
  store: ConversationStore;
  provider: LlmProvider;
  tools: ToolRegistry;
  approvals: ApprovalGate;
  sandbox?: ComputerSupervisor;
};

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
  sandbox?: ComputerSupervisor;
}): void {
  const tools = context.tools ?? createDefaultTools({});
  if (context.sandbox) registerComputerTools(tools, context.sandbox);
  current = {
    store: context.store,
    provider: context.provider,
    tools,
    approvals: context.approvals ?? new ApprovalGate(),
    sandbox: context.sandbox,
  };
}

export async function resetAppContext(): Promise<void> {
  const existing = current;
  current = undefined;
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
  if (!current) {
    const dataDir = process.env.DATA_DIR?.trim() || ".data/pglite";
    const store = await ConversationStore.open(dataDir);
    try {
      const sandbox = await openComputer({ env: process.env });
      const tools = createDefaultTools(process.env);
      registerComputerTools(tools, sandbox);
      const inner = selectProvider(process.env);
      current = {
        store,
        sandbox,
        tools,
        approvals: new ApprovalGate(),
        provider: new SandboxTurnProvider({
          inner,
          delayMs: inner.id === "mock" ? streamDelay(process.env) : 0,
        }),
      };
    } catch (error) {
      await store.close();
      throw error;
    }
  }
  return current;
}
