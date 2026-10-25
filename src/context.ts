import { selectProvider, type LlmProvider } from "./llm";
import { RoutineStore } from "./routines/store";
import { ConversationStore } from "./store";

export type AppContext = {
  store: ConversationStore;
  provider: LlmProvider;
  routines?: RoutineStore;
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
    const store = await ConversationStore.open(dataDir);
    current = {
      store,
      provider: selectProvider(process.env),
      routines: await RoutineStore.attach(store),
    };
  }
  return current;
}
