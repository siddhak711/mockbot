import type { ConnectorRecord } from "../connectors";
import {
  parseOAuthToken,
  refreshStoredOAuthToken,
  serializeOAuthToken,
  type StoredOAuthToken,
} from "../connectors/oauth/token";
import { redact } from "../tools/http";
import { connectorDataDir, decryptSecret, encryptSecret } from "./vault";

type SecretConnector = Pick<ConnectorRecord, "secretRef" | "secretCipher"> & {
  id?: string;
  catalogId?: string | null;
};

const refreshing = new Map<string, Promise<StoredOAuthToken>>();

export async function resolveConnectorSecret(
  connector: SecretConnector,
  env: Record<string, string | undefined>,
): Promise<{ ok: true; secret?: string } | { ok: false; error: string }> {
  if (connector.secretCipher) {
    try {
      const secret = await decryptSecret(connector.secretCipher, connectorDataDir(env));
      const oauth = parseOAuthToken(secret);
      if (!oauth || !connector.catalogId) return { ok: true, secret };
      const fresh = await refreshCatalogToken(connector, oauth, env, false);
      return { ok: true, secret: fresh.accessToken };
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (
        /token request|Reconnect |token endpoint|Could not reach|CONNECTOR_SECRET_KEY|could not be stored/i.test(
          message,
        )
      ) {
        return { ok: false, error: message.slice(0, 500) };
      }
      return { ok: false, error: "The stored connector secret could not be read." };
    }
  }
  return resolveSecret(connector.secretRef, env);
}

export async function forceRefreshConnectorToken(
  connector: SecretConnector & { id: string },
  env: Record<string, string | undefined>,
): Promise<string | null> {
  if (!connector.secretCipher || !connector.catalogId) return null;
  const secret = await decryptSecret(connector.secretCipher, connectorDataDir(env));
  const oauth = parseOAuthToken(secret);
  if (!oauth?.refreshToken) return null;
  const fresh = await refreshCatalogToken(connector, oauth, env, true);
  return fresh.accessToken;
}

export function resolveSecret(
  secretRef: string | null,
  env: Record<string, string | undefined>,
): { ok: true; secret?: string } | { ok: false; error: string } {
  if (!secretRef) return { ok: true };
  const secret = env[secretRef];
  if (!secret) return { ok: false, error: `Set ${secretRef} on the server before connecting.` };
  return { ok: true, secret };
}

export async function secretsFor(
  connectors: readonly Pick<ConnectorRecord, "secretRef" | "secretCipher">[],
  env: Record<string, string | undefined>,
): Promise<string[]> {
  const values: string[] = [];
  for (const connector of connectors) {
    const resolved = await resolveConnectorSecret(connector, env);
    if (resolved.ok && resolved.secret) values.push(resolved.secret);
  }
  return values;
}

async function refreshCatalogToken(
  connector: SecretConnector,
  token: StoredOAuthToken,
  env: Record<string, string | undefined>,
  force: boolean,
): Promise<StoredOAuthToken> {
  const key = connector.id || token.accessToken;
  const existing = refreshing.get(key);
  // A 401 retry must wait for the refresh already in flight. Starting another
  // spends the same rotating refresh token and Notion rejects the second one.
  if (existing) return existing;
  const run = refreshStoredOAuthToken({
    catalogId: connector.catalogId || "",
    token,
    env,
    force,
  }).then(async (result) => {
    if (result.refreshed) await persistOAuthToken(connector, result.token, env);
    return result.token;
  });
  refreshing.set(key, run);
  try {
    return await run;
  } finally {
    if (refreshing.get(key) === run) refreshing.delete(key);
  }
}

async function persistOAuthToken(
  connector: SecretConnector,
  token: StoredOAuthToken,
  env: Record<string, string | undefined>,
): Promise<void> {
  const cipher = await encryptSecret(serializeOAuthToken(token), connectorDataDir(env));
  connector.secretCipher = cipher;
  if (!connector.id) return;
  const { getAppContext } = await import("../context");
  const { store } = await getAppContext();
  const saved = await store.setConnectorSecret(connector.id, cipher);
  if (!saved) throw new Error("The refreshed token could not be stored. Reconnect the connector.");
}

export function redactSecrets(text: string, secrets: readonly string[]): string {
  const unique = [...new Set(secrets.filter((secret) => secret.length > 0))].sort(
    (a, b) => b.length - a.length,
  );
  return unique.reduce((current, secret) => redact(current, secret), text);
}
