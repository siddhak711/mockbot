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
    const dataDir = process.env.DATA_DIR?.trim() || ".data/pglite";
    current = {
      store: await ConversationStore.open(dataDir),
      provider: selectProvider(process.env),
    };
  }
  return current;
}
