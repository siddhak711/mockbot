export interface Clock {
  now(): Date;
}

export function systemClock(): Clock {
  return { now: () => new Date() };
}

export function pollIntervalMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env.ROUTINE_POLL_MS?.trim();
  if (!raw) return 1000;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 50) return 1000;
  return Math.min(Math.floor(value), 60_000);
}

export function workerIdFromEnv(env: Record<string, string | undefined>, pid: number): string {
  const configured = env.ROUTINE_WORKER_ID?.trim();
  if (configured) return configured.slice(0, 200);
  return `worker-${pid}`;
}

/** Dev starts the loop inside the app process. Production uses `npm run routines`. */
export function shouldStartInlineWorker(env: Record<string, string | undefined>): boolean {
  const mode = env.ROUTINES_WORKER?.trim().toLowerCase();
  if (mode === "off" || mode === "external" || mode === "process") return false;
  if (mode === "inline") return true;
  return env.NODE_ENV === "development";
}
