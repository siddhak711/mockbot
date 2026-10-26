import type { ConnectorRecord } from "../connectors";
import { redact } from "../tools/http";
import { connectorDataDir, decryptSecret } from "./vault";

export async function resolveConnectorSecret(
  connector: Pick<ConnectorRecord, "secretRef" | "secretCipher">,
  env: Record<string, string | undefined>,
): Promise<{ ok: true; secret?: string } | { ok: false; error: string }> {
  if (connector.secretCipher) {
    try {
      const secret = await decryptSecret(connector.secretCipher, connectorDataDir(env));
      return { ok: true, secret };
    } catch {
      return { ok: false, error: "The stored connector secret could not be read." };
    }
  }
  return resolveSecret(connector.secretRef, env);
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

export function redactSecrets(text: string, secrets: readonly string[]): string {
  const unique = [...new Set(secrets.filter((secret) => secret.length > 0))].sort(
    (a, b) => b.length - a.length,
  );
  return unique.reduce((current, secret) => redact(current, secret), text);
}
