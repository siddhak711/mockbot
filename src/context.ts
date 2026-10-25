import { selectProvider, type LlmProvider } from "./llm";
import { RoutineStore } from "./routines/store";
import { ConversationStore } from "./store";

export type AppContext = {
  store: ConversationStore;
  provider: LlmProvider;
  routines?: RoutineStore;
};

const GLOBAL_KEY = "__mockbotAppContext";

type Slot = {
  current?: AppContext;
  opening?: Promise<AppContext>;
};

let current: AppContext | undefined;

function slot(): Slot {
  const g = globalThis as typeof globalThis & { [GLOBAL_KEY]?: Slot };
  if (!g[GLOBAL_KEY]) g[GLOBAL_KEY] = {};
  return g[GLOBAL_KEY];
}

export function setAppContext(context: AppContext): void {
  current = context;
  const shared = slot();
  shared.current = context;
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
    const dataDir = process.env.DATA_DIR?.trim() || ".data/pglite";
    shared.opening = ConversationStore.open(dataDir).then(async (store) => ({
      store,
      provider: selectProvider(process.env),
      routines: await RoutineStore.attach(store),
    }));
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
