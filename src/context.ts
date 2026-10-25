import { selectProvider, type LlmProvider } from "./llm";
import { openComputer } from "./sandbox/open";
import type { ComputerSupervisor } from "./sandbox/supervisor";
import { SandboxTurnProvider } from "./sandbox/turn";
import { ConversationStore } from "./store";

export type AppContext = {
  store: ConversationStore;
  provider: LlmProvider;
  sandbox?: ComputerSupervisor;
};

let current: AppContext | undefined;

export function setAppContext(context: AppContext): void {
  current = context;
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
      const inner = selectProvider(process.env);
      current = {
        store,
        sandbox,
        provider: new SandboxTurnProvider({
          inner,
          supervisor: sandbox,
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
