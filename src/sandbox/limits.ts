export const DEFAULT_AGENT_ID = "agent";

export const DEFAULT_COMMAND_TIMEOUT_MS = 10_000;

export const MAX_COMMAND_TIMEOUT_MS = 60_000;

export const MAX_COMMAND_CHARS = 2_000;

export const MAX_FILE_BYTES = 200_000;

export const MAX_OUTPUT_CHARS = 8_000;

export const SANDBOX_CWD = "workspace";

const AGENT_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function normalizeAgentId(value: string | undefined): string | null {
  const id = (value ?? DEFAULT_AGENT_ID).trim() || DEFAULT_AGENT_ID;
  return AGENT_ID.test(id) ? id : null;
}

export function commandTimeoutMs(env: Record<string, string | undefined>): number {
  const raw = env.SANDBOX_COMMAND_TIMEOUT_MS?.trim();
  if (!raw) return DEFAULT_COMMAND_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_COMMAND_TIMEOUT_MS;
  return Math.min(parsed, MAX_COMMAND_TIMEOUT_MS);
}

export function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

export function clip(value: string, max = MAX_OUTPUT_CHARS): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n[truncated]`;
}

function hasUnsafePathChar(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x1f) return true;
    if (char === '"' || char === "'" || char === "`" || char === "$") return true;
  }
  return false;
}

export function toSandboxPath(logical: string): string {
  if (!logical) return SANDBOX_CWD;
  return `${SANDBOX_CWD}/${logical}`;
}

export function resolveWorkspacePath(input: string): { path: string } | { error: string } {
  const raw = input.trim();
  if (!raw || raw === ".") return { path: "" };
  if (hasUnsafePathChar(raw)) return { error: "Path is outside the sandbox workspace." };
  if (raw.startsWith("/") || raw.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(raw)) {
    return { error: "Path is outside the sandbox workspace." };
  }
  const parts = raw.split(/[\\/]+/);
  const stack: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (stack.length === 0) return { error: "Path is outside the sandbox workspace." };
      stack.pop();
      continue;
    }
    if (part.length > 240) return { error: "Path is too long." };
    stack.push(part);
  }
  if (stack.length > 16) return { error: "Path is too long." };
  return { path: stack.join("/") };
}
