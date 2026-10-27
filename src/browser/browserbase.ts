/**
 * Browserbase sessions, created and released by the app server. The sandbox
 * daemon only ever sees a session's short-lived connect URL, never the API key.
 */

export const BROWSERBASE_API = "https://api.browserbase.com/v1";

/** The free plan caps sessions at 15 minutes. */
export const BROWSERBASE_SESSION_SECONDS = 15 * 60;

/** A session this close to expiry is replaced before the next action. */
export const SESSION_EXPIRY_MARGIN_MS = 60_000;

/** Release an unused session after this long, so it does not hold a concurrency slot. */
export const SESSION_IDLE_MS = 5 * 60_000;

export const BROWSERBASE_NOT_CONNECTED = "Browserbase isn't connected";

export type BrowserbaseSettings = { apiKey: string; projectId: string };

export type RemoteBrowserSession = {
  id: string;
  /** Short-lived CDP URL. Carries a per-session signing key, not the API key. */
  connectUrl: string;
  /** Epoch milliseconds. */
  expiresAt: number;
};

/** Where the sandbox browser gets a session to connect to. */
export interface BrowserSessionSource {
  acquire(signal?: AbortSignal): Promise<RemoteBrowserSession>;
  /** Drop a session that ended early, such as one Browserbase timed out. */
  invalidate(id: string): Promise<void>;
  close(): Promise<void>;
}

export function readBrowserbaseSettings(
  env: Record<string, string | undefined>,
): { ok: true; settings: BrowserbaseSettings } | { ok: false; error: string } {
  const apiKey = env.BROWSERBASE_API_KEY?.trim();
  const projectId = env.BROWSERBASE_PROJECT_ID?.trim();
  const missing = [
    ...(apiKey ? [] : ["BROWSERBASE_API_KEY"]),
    ...(projectId ? [] : ["BROWSERBASE_PROJECT_ID"]),
  ];
  if (!apiKey || !projectId) {
    return {
      ok: false,
      error: `${BROWSERBASE_NOT_CONNECTED}: ${missing.join(" and ")} ${
        missing.length > 1 ? "are" : "is"
      } not set, so browse cannot open a browser.`,
    };
  }
  return { ok: true, settings: { apiKey, projectId } };
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * One Browserbase session at a time per sandbox browser. It is created on the
 * first action, reused until it nears expiry or ends, and released on close or
 * after it sits idle.
 */
export class BrowserbaseSessions implements BrowserSessionSource {
  #current: RemoteBrowserSession | null = null;
  #pending: Promise<RemoteBrowserSession> | null = null;
  #idle: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly settings: BrowserbaseSettings,
    private readonly options: {
      fetch?: FetchLike;
      now?: () => number;
      idleMs?: number;
    } = {},
  ) {}

  get current(): RemoteBrowserSession | null {
    return this.#current;
  }

  async acquire(signal?: AbortSignal): Promise<RemoteBrowserSession> {
    this.#touch();
    const current = this.#current;
    if (current && current.expiresAt - this.#now() > SESSION_EXPIRY_MARGIN_MS) return current;
    if (current) await this.#release(current);
    if (!this.#pending) {
      this.#pending = this.#create(signal).finally(() => {
        this.#pending = null;
      });
    }
    const session = await this.#pending;
    this.#current = session;
    return session;
  }

  async invalidate(id: string): Promise<void> {
    const current = this.#current;
    if (current?.id === id) await this.#release(current);
  }

  async close(): Promise<void> {
    if (this.#idle) clearTimeout(this.#idle);
    this.#idle = null;
    const current = this.#current;
    if (current) await this.#release(current);
  }

  #now(): number {
    return this.options.now?.() ?? Date.now();
  }

  #touch(): void {
    if (this.#idle) clearTimeout(this.#idle);
    this.#idle = setTimeout(() => void this.close(), this.options.idleMs ?? SESSION_IDLE_MS);
    this.#idle.unref?.();
  }

  async #create(signal?: AbortSignal): Promise<RemoteBrowserSession> {
    let response: Response;
    try {
      response = await this.#fetch(`${BROWSERBASE_API}/sessions`, {
        method: "POST",
        headers: this.#headers(),
        body: JSON.stringify({
          projectId: this.settings.projectId,
          timeout: BROWSERBASE_SESSION_SECONDS,
        }),
        signal,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new Error(`Browserbase could not be reached: ${errorText(error)}`, { cause: error });
    }
    if (!response.ok) throw new Error(await createFailure(response));
    const body = (await response.json().catch(() => null)) as {
      id?: unknown;
      connectUrl?: unknown;
      expiresAt?: unknown;
    } | null;
    if (typeof body?.id !== "string" || typeof body.connectUrl !== "string") {
      throw new Error("Browserbase returned a session without a connect URL.");
    }
    const expires = typeof body.expiresAt === "string" ? Date.parse(body.expiresAt) : NaN;
    return {
      id: body.id,
      connectUrl: body.connectUrl,
      expiresAt: Number.isFinite(expires)
        ? expires
        : this.#now() + BROWSERBASE_SESSION_SECONDS * 1000,
    };
  }

  async #release(session: RemoteBrowserSession): Promise<void> {
    if (this.#current?.id === session.id) this.#current = null;
    try {
      await this.#fetch(`${BROWSERBASE_API}/sessions/${encodeURIComponent(session.id)}`, {
        method: "POST",
        headers: this.#headers(),
        body: JSON.stringify({ projectId: this.settings.projectId, status: "REQUEST_RELEASE" }),
      });
    } catch {
      // Browserbase ends the session at its timeout anyway.
    }
  }

  #headers(): Record<string, string> {
    return { "X-BB-API-Key": this.settings.apiKey, "Content-Type": "application/json" };
  }

  #fetch(input: string, init?: RequestInit): Promise<Response> {
    return (this.options.fetch ?? fetch)(input, init);
  }
}

async function createFailure(response: Response): Promise<string> {
  const detail = (await response.text().catch(() => "")).trim().slice(0, 200);
  if (response.status === 401 || response.status === 403) {
    return `${BROWSERBASE_NOT_CONNECTED}: Browserbase rejected the API key (HTTP ${response.status}).`;
  }
  if (response.status === 429) {
    return "Browserbase is at its limit of concurrent browser sessions (the free plan allows 3). Try again in a minute.";
  }
  if (response.status === 402) {
    return "Browserbase refused a new session: the plan's browser minutes are used up (HTTP 402).";
  }
  return `Browserbase could not start a session (HTTP ${response.status})${detail ? `: ${detail}` : "."}`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
