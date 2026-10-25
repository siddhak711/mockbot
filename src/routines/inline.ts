import { getAppContext } from "../context";
import { pollIntervalMs, shouldStartInlineWorker, systemClock, workerIdFromEnv } from "./clock";
import { runWorker } from "./worker";

const STARTED = "__mockbotRoutineWorker";

/** Local/dev mode: the same worker loop, sharing this process's embedded Postgres. */
export async function startInlineWorker(
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  if (!shouldStartInlineWorker(env)) return;
  const g = globalThis as typeof globalThis & { [STARTED]?: boolean };
  if (g[STARTED]) return;
  g[STARTED] = true;
  let context;
  try {
    context = await getAppContext();
  } catch (error) {
    g[STARTED] = false;
    throw error;
  }
  if (!context.routines) {
    g[STARTED] = false;
    return;
  }
  const workerId = workerIdFromEnv(env, process.pid);
  const pollMs = pollIntervalMs(env);
  console.log(`Routine worker ${workerId} polling every ${pollMs}ms (in-process)`);
  void runWorker({
    routines: context.routines,
    store: context.store,
    provider: context.provider,
    clock: systemClock(),
    workerId,
    pollMs,
    signal: new AbortController().signal,
    onTick: (result) => {
      if (result.claimed === 0) return;
      console.log(
        `Routine worker claimed ${result.claimed}, succeeded ${result.succeeded}, failed ${result.failed}`,
      );
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : "Routine worker tick failed";
      console.error(`Routine worker: ${message}`);
    },
  });
}
