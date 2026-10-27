import { getAppContext } from "../context";
import { pollIntervalMs, systemClock, workerIdFromEnv } from "./clock";
import { runWorker } from "./worker";

const controller = new AbortController();
const stop = () => controller.abort();
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

const { store, provider, routines, agents } = await getAppContext();
if (!routines) throw new Error("Routines are not attached");

const workerId = workerIdFromEnv(process.env, process.pid);
const pollMs = pollIntervalMs();
console.log(`Routine worker ${workerId} polling every ${pollMs}ms`);

await runWorker({
  routines,
  store,
  provider,
  agents,
  clock: systemClock(),
  workerId,
  pollMs,
  signal: controller.signal,
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

await store.close();
