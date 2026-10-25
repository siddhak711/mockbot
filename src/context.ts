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
};

let current: AppContext | undefined;

export function setAppContext(context: {
  store: ConversationStore;
  provider: LlmProvider;
  tools?: ToolRegistry;
  approvals?: ApprovalGate;
}): void {
  current = {
    store: context.store,
    provider: context.provider,
    tools: context.tools ?? createDefaultTools({}),
    approvals: context.approvals ?? new ApprovalGate(),
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
    current = {
      store: await ConversationStore.open(dataDir),
      provider: selectProvider(process.env),
      tools: createDefaultTools(process.env),
      approvals: new ApprovalGate(),
    };
  }
  return current;
}
