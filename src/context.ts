import { selectProvider, type LlmProvider } from "./llm";
import { ConversationStore } from "./store";
import { ApprovalGate } from "./tools/approval";
import { createDefaultTools } from "./tools/builtins";
import { registerMemoryTools, type ToolRegistry } from "./tools/registry";

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
  const tools = context.tools ?? createDefaultTools({});
  if (!context.tools) registerMemoryTools(tools, context.store);
  current = {
    store: context.store,
    provider: context.provider,
    tools,
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
    const store = await ConversationStore.connect(process.env);
    const tools = createDefaultTools(process.env);
    registerMemoryTools(tools, store);
    current = {
      store,
      provider: selectProvider(process.env),
      tools,
      approvals: new ApprovalGate(),
    };
  }
  return current;
}
