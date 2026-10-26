import { createHash, randomBytes } from "node:crypto";
import { catalogIsWired, type CatalogEntry } from "../catalog";

export type OAuthTokenSet = {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scope?: string;
  tokenType?: string;
  raw: Record<string, unknown>;
};

export function createOAuthState(): string {
  return randomBytes(16).toString("base64url");
}

export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function publicOrigin(request: Request, env: Record<string, string | undefined>): string {
  const configured = env.APP_ORIGIN?.trim();
  if (configured) return configured.replace(/\/$/, "");
  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  if (forwardedHost) {
    const proto = forwardedProto || "https";
    return `${proto}://${forwardedHost}`;
  }
  return new URL(request.url).origin;
}

export function oauthRedirectUri(origin: string, entry: CatalogEntry): string {
  const path = entry.oauth?.redirectPath || "/connectors/oauth/callback";
  return new URL(path, origin).toString();
}

export function oauthCredentialError(
  entry: CatalogEntry,
  env: Record<string, string | undefined>,
): string | null {
  if (!entry.oauth || !catalogIsWired(entry)) return `${entry.name} is not available yet.`;
  const clientId = env[entry.oauth.clientIdEnv]?.trim();
  const clientSecret = env[entry.oauth.clientSecretEnv]?.trim();
  if (!clientId || !clientSecret) {
    return `Set ${entry.oauth.clientIdEnv} and ${entry.oauth.clientSecretEnv} to connect ${entry.name}.`;
  }
  return null;
}

export function oauthClient(
  entry: CatalogEntry,
  env: Record<string, string | undefined>,
): { clientId: string; clientSecret: string } {
  const error = oauthCredentialError(entry, env);
  if (error) throw new Error(error);
  const oauth = entry.oauth;
  if (!oauth) throw new Error(`${entry.name} is not available yet.`);
  return {
    clientId: env[oauth.clientIdEnv]?.trim() ?? "",
    clientSecret: env[oauth.clientSecretEnv]?.trim() ?? "",
  };
}

export function buildAuthorizeUrl(
  entry: CatalogEntry,
  options: {
    env: Record<string, string | undefined>;
    redirectUri: string;
    state: string;
    challenge?: string;
  },
): string {
  const oauth = entry.oauth;
  if (!oauth || !catalogIsWired(entry)) throw new Error(`${entry.name} is not available yet.`);
  const { clientId } = oauthClient(entry, options.env);
  const url = new URL(oauth.authorizeUrl);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", options.redirectUri);
  url.searchParams.set("state", options.state);
  if (oauth.scopes.length > 0) url.searchParams.set("scope", oauth.scopes.join(" "));
  for (const [key, value] of Object.entries(oauth.authorizeParams ?? {})) {
    url.searchParams.set(key, value);
  }
  if (oauth.pkce) {
    if (!options.challenge) throw new Error(`${entry.name} requires PKCE.`);
    url.searchParams.set("code_challenge", options.challenge);
    url.searchParams.set("code_challenge_method", "S256");
  }
  return url.toString();
}

export async function exchangeAuthorizationCode(options: {
  entry: CatalogEntry;
  env: Record<string, string | undefined>;
  code: string;
  redirectUri: string;
  verifier?: string;
  fetchImpl?: typeof fetch;
  now?: number;
}): Promise<OAuthTokenSet> {
  const body: Record<string, string> = {
    grant_type: "authorization_code",
    code: options.code,
    redirect_uri: options.redirectUri,
  };
  if (options.verifier) body.code_verifier = options.verifier;
  return requestToken({
    entry: options.entry,
    env: options.env,
    body,
    fetchImpl: options.fetchImpl ?? fetch,
    now: options.now ?? Date.now(),
  });
}

export async function refreshAccessToken(options: {
  entry: CatalogEntry;
  env: Record<string, string | undefined>;
  refreshToken: string;
  fetchImpl?: typeof fetch;
  now?: number;
}): Promise<OAuthTokenSet> {
  return requestToken({
    entry: options.entry,
    env: options.env,
    body: { grant_type: "refresh_token", refresh_token: options.refreshToken },
    fetchImpl: options.fetchImpl ?? fetch,
    now: options.now ?? Date.now(),
  });
}

export async function readAccountLabel(options: {
  entry: CatalogEntry;
  token: OAuthTokenSet;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const oauth = options.entry.oauth;
  const fromToken = oauth?.accountField ? stringField(options.token.raw, oauth.accountField) : "";
  if (fromToken) return fromToken.slice(0, 80);
  if (oauth?.userInfoUrl && oauth.userInfoField && options.token.accessToken) {
    try {
      const response = await (options.fetchImpl ?? fetch)(oauth.userInfoUrl, {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${options.token.accessToken}`,
          "User-Agent": "mockbot",
        },
      });
      const raw = (await response.json().catch(() => null)) as Record<string, unknown> | null;
      const account = raw ? stringField(raw, oauth.userInfoField) : "";
      if (response.ok && account) return account.slice(0, 80);
    } catch {
      // The token is still usable when the profile request fails.
    }
  }
  return options.entry.name;
}

async function requestToken(options: {
  entry: CatalogEntry;
  env: Record<string, string | undefined>;
  body: Record<string, string>;
  fetchImpl: typeof fetch;
  now: number;
}): Promise<OAuthTokenSet> {
  const oauth = options.entry.oauth;
  if (!oauth) throw new Error(`${options.entry.name} is not available yet.`);
  const { clientId, clientSecret } = oauthClient(options.entry, options.env);
  const headers: Record<string, string> = { Accept: "application/json" };
  let payload: string;
  if (oauth.tokenAuth === "basic") {
    headers.Authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(options.body);
  } else {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    payload = new URLSearchParams({
      ...options.body,
      client_id: clientId,
      client_secret: clientSecret,
    }).toString();
  }
  let response: Response;
  try {
    response = await options.fetchImpl(oauth.tokenUrl, {
      method: "POST",
      headers,
      body: payload,
    });
  } catch {
    throw new Error(`Could not reach the ${options.entry.name} token endpoint.`);
  }
  const text = await response.text();
  let raw: Record<string, unknown>;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not-json");
    }
    raw = parsed as Record<string, unknown>;
  } catch {
    throw new Error(`${options.entry.name} token endpoint did not return JSON.`);
  }
  if (!response.ok || typeof raw.error === "string") {
    const description =
      typeof raw.error_description === "string"
        ? raw.error_description
        : typeof raw.error === "string"
          ? raw.error
          : typeof raw.message === "string"
            ? raw.message
            : `HTTP ${response.status}`;
    throw new Error(
      `${options.entry.name} rejected the token request: ${description}`.slice(0, 300),
    );
  }
  if (typeof raw.access_token !== "string" || !raw.access_token) {
    throw new Error(`${options.entry.name} did not return an access token.`);
  }
  const expiresIn = typeof raw.expires_in === "number" ? raw.expires_in : undefined;
  return {
    accessToken: raw.access_token,
    ...(typeof raw.refresh_token === "string" && raw.refresh_token
      ? { refreshToken: raw.refresh_token }
      : {}),
    ...(expiresIn && expiresIn > 0 ? { expiresAt: options.now + expiresIn * 1000 } : {}),
    ...(typeof raw.scope === "string" ? { scope: raw.scope } : {}),
    ...(typeof raw.token_type === "string" ? { tokenType: raw.token_type } : {}),
    raw,
  };
}

function stringField(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  return typeof value === "string" ? value.trim() : "";
}
