/** Browser actions one chat run may take. The next call past this ends the run. */
export const MAX_BROWSE_ACTIONS = 20;

export const DEFAULT_BROWSE_TIMEOUT_MS = 10_000;

export const MAX_BROWSE_TIMEOUT_MS = 60_000;

/** Time the sandbox gets to launch Chromium before the first action starts. */
export const BROWSER_START_TIMEOUT_MS = 20_000;

/** Extra time the host waits past the action timeout before it gives up on the sandbox. */
export const BROWSER_EXEC_MARGIN_MS = 5_000;

/** First-use install of Node, Playwright, and Chromium inside the sandbox. */
export const BROWSER_INSTALL_TIMEOUT_MS = 600_000;

export const MAX_URL_CHARS = 2_048;

export const MAX_SELECTOR_CHARS = 500;

export const MAX_TYPE_CHARS = 2_000;

export const MAX_EXTRACT_CHARS = 4_000;

export const BROWSER_VIEWPORT = { width: 1024, height: 640 } as const;

export function browseTimeoutMs(env: Record<string, string | undefined>): number {
  const raw = env.BROWSE_ACTION_TIMEOUT_MS?.trim();
  if (!raw) return DEFAULT_BROWSE_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_BROWSE_TIMEOUT_MS;
  return Math.min(parsed, MAX_BROWSE_TIMEOUT_MS);
}
