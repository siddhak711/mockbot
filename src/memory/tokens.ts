export const PROFILE_TOKEN_BUDGET = 500;
export const SEARCH_TOKEN_BUDGET = 400;
export const SEARCH_TOP_K = 5;
export const SUMMARY_TOKEN_BUDGET = 800;
export const COMPACT_RATIO = 0.6;
export const VERBATIM_RATIO = 0.4;

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

export function trimToTokens(
  text: string,
  tokens: number,
  edge: "start" | "end" = "start",
): string {
  if (tokens <= 0 || !text) return "";
  if (estimateTokens(text) <= tokens) return text;
  const maxChars = Math.max(0, tokens * 4 - 1);
  if (maxChars <= 1) return "";
  if (edge === "end") return `…${text.slice(text.length - (maxChars - 1))}`;
  return `${text.slice(0, maxChars - 1)}…`;
}

export function fitBlock(lines: string[], budget: number): string {
  if (budget <= 0) return "";
  let text = "";
  for (const line of lines) {
    const next = text ? `${text}\n${line}` : line;
    if (estimateTokens(next) <= budget) {
      text = next;
      continue;
    }
    const prefix = text ? `${text}\n` : "";
    const room = budget - estimateTokens(prefix);
    const trimmed = trimToTokens(line, room);
    if (trimmed && estimateTokens(prefix + trimmed) <= budget) text = prefix + trimmed;
    break;
  }
  return text;
}

export function contextTokenLimit(env: Record<string, string | undefined>): number {
  const raw = env.LLM_CONTEXT_TOKENS?.trim();
  if (!raw) return 8192;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 256) return 8192;
  return Math.floor(parsed);
}
