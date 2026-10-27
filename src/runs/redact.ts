const SENSITIVE_KEY =
  /^(?:password|passwd|passphrase|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|authorization|auth(?:_token)?|private[_-]?key|client[_-]?secret|session[_-]?token|token|bearer)$/i;

const KEY_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-ant-[A-Za-z0-9_-]{8,}\b/g,
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{16,}\b/g,
  /\bghp_[A-Za-z0-9]{16,}\b/g,
  /\bgho_[A-Za-z0-9]{16,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{8,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /\bBearer\s+[A-Za-z0-9\-._~+/]{8,}={0,2}\b/gi,
];

const HEADER_RE =
  /\b(authorization|proxy-authorization|x-api-key|api-key|x-auth-token)\s*:\s*[^\s,}"']+/gi;

const ASSIGN_RE =
  /(["']?)(password|passwd|passphrase|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|session[_-]?token|auth_token|token|bearer)\1(\s*[:=]\s*)("[^"]*"|'[^']*'|\S+)/gi;

const MAX_DEPTH = 16;

function replaceAll(text: string, pattern: RegExp, replacement: string): string {
  pattern.lastIndex = 0;
  return text.replace(pattern, replacement);
}

function applyPatterns(text: string): string {
  let next = text;
  for (const pattern of KEY_PATTERNS) {
    next = replaceAll(next, pattern, "[redacted]");
  }
  next = replaceAll(next, HEADER_RE, "$1: [redacted]");
  ASSIGN_RE.lastIndex = 0;
  next = next.replace(ASSIGN_RE, (match, quote: string, name: string, sep: string, raw: string) => {
    const value = raw.replace(/^['"]|['"]$/g, "");
    if (/^(?:token|tokens)$/i.test(name) && /^\d+(?:\.\d+)?$/.test(value)) return match;
    const redacted = raw.startsWith("'")
      ? "'[redacted]'"
      : raw.startsWith('"')
        ? '"[redacted]"'
        : "[redacted]";
    return `${quote}${name}${quote}${sep}${redacted}`;
  });
  return next;
}

function decodePercents(text: string): string {
  return text.replace(/%[0-9A-Fa-f]{2}/g, (sequence) => {
    try {
      return decodeURIComponent(sequence);
    } catch {
      return sequence;
    }
  });
}

/** Secrets also hide in percent-encoded tool output, such as a search URL. */
function redactPlain(text: string): string {
  const direct = applyPatterns(text);
  const decoded = decodePercents(text);
  if (decoded === text) return direct;
  const fromDecoded = applyPatterns(decoded);
  if (fromDecoded === decoded) return direct;
  return fromDecoded;
}

function redactValue(value: unknown, depth: number): unknown {
  if (typeof value === "string") return redactText(value, depth);
  if (depth > MAX_DEPTH) return value;
  if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1));
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    output[key] = SENSITIVE_KEY.test(key) ? "[redacted]" : redactValue(item, depth + 1);
  }
  return output;
}

function redactText(text: string, depth: number): string {
  const trimmed = text.trim();
  if (
    depth < MAX_DEPTH &&
    ((trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]")))
  ) {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === "object") {
        return JSON.stringify(redactValue(parsed, depth + 1));
      }
    } catch {
      // The text only looks like JSON. Fall through to pattern redaction.
    }
  }
  return redactPlain(text);
}

/** Replace API keys, tokens, passwords, and auth headers. The shape of JSON is kept. */
export function redactSecrets(value: string): string {
  return redactText(value, 0);
}
