import type { FetchLike } from "./types";

export function clip(text: string, max = 8_000): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…truncated`;
}

export function present(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function redact(text: string, secret: string | undefined): string {
  if (!secret) return text;
  return text.split(secret).join("[redacted]");
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export type ToolRequestInit = RequestInit & {
  parentSignal?: AbortSignal;
  timeoutSignal?: AbortSignal;
};

export function toolFetchInit(
  parent: AbortSignal | undefined,
  init: RequestInit = {},
  timeoutMs = 20_000,
): ToolRequestInit {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = parent ? AbortSignal.any([parent, timeoutSignal]) : timeoutSignal;
  return { ...init, signal, parentSignal: parent, timeoutSignal };
}

export async function readJson(
  fetchImpl: FetchLike,
  url: string,
  init: ToolRequestInit,
  secret?: string,
): Promise<{ ok: true; body: unknown } | { ok: false; error: string }> {
  const { parentSignal, timeoutSignal, ...request } = init;
  try {
    const response = await fetchImpl(url, request);
    const text = await response.text();
    if (!response.ok) {
      return {
        ok: false,
        error: `Request failed (${response.status}): ${redact(text, secret).slice(0, 500)}`,
      };
    }
    try {
      return { ok: true, body: JSON.parse(text) as unknown };
    } catch {
      return { ok: false, error: "The service returned a response that was not JSON." };
    }
  } catch (error) {
    if (!parentSignal?.aborted && timeoutSignal?.aborted) {
      return { ok: false, error: "The tool request timed out." };
    }
    if (isAbortError(error)) throw error;
    if (error instanceof Error && error.name === "TimeoutError") {
      return { ok: false, error: "The tool request timed out." };
    }
    const message = error instanceof Error ? error.message : "Request failed";
    return { ok: false, error: redact(message, secret) };
  }
}

export function jsonResult(value: unknown, secret?: string): string {
  return clip(redact(JSON.stringify(value, null, 2), secret));
}
