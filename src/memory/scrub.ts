export type SecretKind =
  | "openai_key"
  | "anthropic_key"
  | "github_token"
  | "github_pat"
  | "slack_token"
  | "aws_access_key"
  | "google_api_key"
  | "jwt"
  | "private_key"
  | "bearer"
  | "card"
  | "high_entropy";

const PATTERNS: Array<{ kind: SecretKind; re: RegExp }> = [
  { kind: "anthropic_key", re: /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g },
  { kind: "openai_key", re: /\bsk-[A-Za-z0-9_-]{16,}\b/g },
  { kind: "github_pat", re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { kind: "github_token", re: /\bghp_[A-Za-z0-9]{20,}\b/g },
  { kind: "slack_token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { kind: "aws_access_key", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: "google_api_key", re: /\bAIza[0-9A-Za-z_-]{30,}\b/g },
  { kind: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { kind: "private_key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { kind: "bearer", re: /\bBearer\s+[A-Za-z0-9\-._~+/]{20,}={0,2}\b/gi },
];

export function findSecrets(text: string): SecretKind[] {
  const found = new Set<SecretKind>();
  for (const pattern of PATTERNS) {
    pattern.re.lastIndex = 0;
    if (pattern.re.test(text)) found.add(pattern.kind);
  }
  if (hasCardNumber(text)) found.add("card");
  if (hasHighEntropyToken(text)) found.add("high_entropy");
  return [...found];
}

export function logBlockedMemory(info: { agentId: string; kinds: SecretKind[] }): void {
  console.warn(
    JSON.stringify({
      event: "memory_write_blocked",
      reason: "secret",
      agentId: info.agentId,
      kinds: info.kinds,
    }),
  );
}

function hasCardNumber(text: string): boolean {
  const matches = text.match(/\d(?:[ -]?\d){12,18}/g) ?? [];
  for (const raw of matches) {
    const digits = raw.replace(/\D/g, "");
    if (digits.length < 13 || digits.length > 19) continue;
    if (luhn(digits)) return true;
  }
  return false;
}

function luhn(digits: string): boolean {
  let sum = 0;
  let alternate = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let value = Number(digits[index]);
    if (alternate) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    alternate = !alternate;
  }
  return sum > 0 && sum % 10 === 0;
}

function hasHighEntropyToken(text: string): boolean {
  const tokens = text.match(/[A-Za-z0-9+/=_-]{32,}/g) ?? [];
  return tokens.some(isHighEntropySecret);
}

function isHighEntropySecret(token: string): boolean {
  if (/^[0-9a-f-]{32,36}$/i.test(token)) return false;
  if (!/[A-Za-z]/.test(token) || !/\d/.test(token)) return false;
  if (new Set(token).size < 12) return false;
  return shannon(token) >= 3.8;
}

function shannon(token: string): number {
  const freq = new Map<string, number>();
  for (const char of token) freq.set(char, (freq.get(char) ?? 0) + 1);
  let entropy = 0;
  for (const count of freq.values()) {
    const p = count / token.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}
