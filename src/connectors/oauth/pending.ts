import { connectorDataDir, decryptSecret, encryptSecret } from "../../mcp/vault";

export const OAUTH_COOKIE = "mockbot_oauth";

const MAX_AGE_MS = 10 * 60 * 1000;

export type PendingOAuth = {
  state: string;
  verifier?: string;
  catalogId: string;
  connectorId?: string;
  redirectUri: string;
  issuedAt: number;
  /** Set when the catalog connect is going through Composio. */
  broker?: "composio";
  userId?: string;
  connectedAccountId?: string;
};

export async function sealPending(
  pending: PendingOAuth,
  env: Record<string, string | undefined> = process.env,
): Promise<string> {
  return encryptSecret(JSON.stringify(pending), connectorDataDir(env));
}

export async function openPending(
  raw: string | null,
  env: Record<string, string | undefined> = process.env,
  now = Date.now(),
): Promise<PendingOAuth | null> {
  if (!raw) return null;
  try {
    const json = await decryptSecret(decodeURIComponent(raw), connectorDataDir(env));
    const parsed = JSON.parse(json) as Partial<PendingOAuth>;
    if (!parsed || typeof parsed.state !== "string" || !parsed.state) return null;
    if (typeof parsed.catalogId !== "string" || !parsed.catalogId) return null;
    if (typeof parsed.redirectUri !== "string" || !parsed.redirectUri) return null;
    if (typeof parsed.issuedAt !== "number") return null;
    if (now - parsed.issuedAt > MAX_AGE_MS) return null;
    return {
      state: parsed.state,
      ...(typeof parsed.verifier === "string" && parsed.verifier
        ? { verifier: parsed.verifier }
        : {}),
      catalogId: parsed.catalogId,
      ...(typeof parsed.connectorId === "string" && parsed.connectorId
        ? { connectorId: parsed.connectorId }
        : {}),
      redirectUri: parsed.redirectUri,
      issuedAt: parsed.issuedAt,
      ...(parsed.broker === "composio" ? { broker: "composio" as const } : {}),
      ...(typeof parsed.userId === "string" && parsed.userId ? { userId: parsed.userId } : {}),
      ...(typeof parsed.connectedAccountId === "string" && parsed.connectedAccountId
        ? { connectedAccountId: parsed.connectedAccountId }
        : {}),
    };
  } catch {
    return null;
  }
}

export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    if (trimmed.slice(0, eq) === name) return trimmed.slice(eq + 1);
  }
  return null;
}

export function oauthSetCookie(value: string, secure: boolean, maxAge = 600): string {
  const parts = [
    `${OAUTH_COOKIE}=${encodeURIComponent(value)}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${maxAge}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearOAuthCookie(secure: boolean): string {
  return oauthSetCookie("", secure, 0);
}
