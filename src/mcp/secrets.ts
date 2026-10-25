import { redact } from "../tools/http";

export function resolveSecret(
  secretRef: string | null,
  env: Record<string, string | undefined>,
): { ok: true; secret?: string } | { ok: false; error: string } {
  if (!secretRef) return { ok: true };
  const secret = env[secretRef];
  if (!secret) return { ok: false, error: `Set ${secretRef} on the server before connecting.` };
  return { ok: true, secret };
}

export function secretsFor(
  connectors: readonly { secretRef: string | null }[],
  env: Record<string, string | undefined>,
): string[] {
  const values: string[] = [];
  for (const connector of connectors) {
    if (!connector.secretRef) continue;
    const secret = env[connector.secretRef];
    if (secret) values.push(secret);
  }
  return values;
}

export function redactSecrets(text: string, secrets: readonly string[]): string {
  const unique = [...new Set(secrets.filter((secret) => secret.length > 0))].sort(
    (a, b) => b.length - a.length,
  );
  return unique.reduce((current, secret) => redact(current, secret), text);
}
