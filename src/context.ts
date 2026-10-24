import { selectProvider, type LlmProvider } from "./llm";
import { ConversationStore } from "./store";

export type AppContext = {
  store: ConversationStore;
  provider: LlmProvider;
};

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
    current = {
      store: await ConversationStore.connect(process.env),
      provider: selectProvider(process.env),
    };
  }
  return current;
}
