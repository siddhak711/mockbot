import { catalogById } from "../catalog";
import { refreshAccessToken } from "./flow";

const REFRESH_SKEW_MS = 60_000;

export type StoredOAuthToken = {
  v: 1;
  kind: "oauth";
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scope?: string;
  tokenType?: string;
};

export function serializeOAuthToken(token: StoredOAuthToken): string {
  return JSON.stringify(token);
}

export function parseOAuthToken(payload: string): StoredOAuthToken | null {
  if (!payload.startsWith("{")) return null;
  try {
    const value = JSON.parse(payload) as Partial<StoredOAuthToken>;
    if (value.v !== 1 || value.kind !== "oauth") return null;
    if (typeof value.accessToken !== "string" || !value.accessToken) return null;
    return {
      v: 1,
      kind: "oauth",
      accessToken: value.accessToken,
      ...(typeof value.refreshToken === "string" && value.refreshToken
        ? { refreshToken: value.refreshToken }
        : {}),
      ...(typeof value.expiresAt === "number" ? { expiresAt: value.expiresAt } : {}),
      ...(typeof value.scope === "string" ? { scope: value.scope } : {}),
      ...(typeof value.tokenType === "string" ? { tokenType: value.tokenType } : {}),
    };
  } catch {
    return null;
  }
}

function refreshField(
  next: string | undefined,
  previous: string | undefined,
): { refreshToken?: string } {
  const refreshToken = next || previous;
  return refreshToken ? { refreshToken } : {};
}

export function oauthTokenNeedsRefresh(token: StoredOAuthToken, now = Date.now()): boolean {
  return typeof token.expiresAt === "number" && token.expiresAt - REFRESH_SKEW_MS <= now;
}

export async function refreshStoredOAuthToken(options: {
  catalogId: string;
  token: StoredOAuthToken;
  env: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  now?: number;
  force?: boolean;
}): Promise<{ token: StoredOAuthToken; refreshed: boolean }> {
  const now = options.now ?? Date.now();
  if (!options.force && !oauthTokenNeedsRefresh(options.token, now)) {
    return { token: options.token, refreshed: false };
  }
  const entry = catalogById(options.catalogId);
  if (!entry?.oauth) throw new Error("This connector cannot refresh its token.");
  if (!options.token.refreshToken) {
    throw new Error(`Reconnect ${entry.name}. The access token expired.`);
  }
  const next = await refreshAccessToken({
    entry,
    env: options.env,
    refreshToken: options.token.refreshToken,
    fetchImpl: options.fetchImpl,
    now,
  });
  return {
    refreshed: true,
    token: {
      v: 1,
      kind: "oauth",
      accessToken: next.accessToken,
      ...refreshField(next.refreshToken, options.token.refreshToken),
      ...(next.expiresAt ? { expiresAt: next.expiresAt } : {}),
      ...(next.scope || options.token.scope ? { scope: next.scope || options.token.scope } : {}),
      ...(next.tokenType || options.token.tokenType
        ? { tokenType: next.tokenType || options.token.tokenType }
        : {}),
    },
  };
}
