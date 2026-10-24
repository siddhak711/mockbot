import { DEFAULT_AGENT_ID } from "../agent";
import type { ConversationStore } from "../store";
import type { Message } from "../types";
import { BASE_SYSTEM_PROMPT } from "./prompt";
import {
  COMPACT_RATIO,
  estimateTokens,
  PROFILE_TOKEN_BUDGET,
  SEARCH_TOKEN_BUDGET,
  SUMMARY_TOKEN_BUDGET,
  trimToTokens,
  VERBATIM_RATIO,
} from "./tokens";

const PROMPT_OVERHEAD =
  estimateTokens(BASE_SYSTEM_PROMPT) + PROFILE_TOKEN_BUDGET + SEARCH_TOKEN_BUDGET + 32;

export async function compactIfNeeded(
  store: ConversationStore,
  conversationId: string,
  agentId: string = DEFAULT_AGENT_ID,
  contextTokens = 8192,
): Promise<void> {
  const loaded = await store.getConversation(conversationId, agentId);
  if (!loaded || loaded.messages.length < 3) return;
  const summary = await store.getSummary(conversationId, agentId);
  const messages = loaded.messages;
  const total =
    PROMPT_OVERHEAD +
    estimateTokens(summary?.summary ?? "") +
    messages.reduce((sum, message) => sum + estimateTokens(message.content) + 4, 0);
  if (total <= Math.floor(contextTokens * COMPACT_RATIO)) return;

  const tailBudget = Math.max(64, Math.floor(contextTokens * VERBATIM_RATIO));
  let tailStart = messages.length - 1;
  let used = estimateTokens(messages[tailStart]?.content ?? "") + 4;
  for (let index = messages.length - 2; index >= 0; index -= 1) {
    const cost = estimateTokens(messages[index]?.content ?? "") + 4;
    if (used + cost > tailBudget) break;
    used += cost;
    tailStart = index;
  }
  if (tailStart <= 0) return;

  let start = 0;
  if (summary?.uptoMessageId) {
    const covered = messages.findIndex((message) => message.id === summary.uptoMessageId);
    if (covered >= 0) start = covered + 1;
  }
  if (start >= tailStart) return;
  const older = messages.slice(start, tailStart);
  const summarized = summarizeMessages(summary?.summary ?? null, older);
  const last = older[summarized.covered - 1];
  if (!last || summarized.covered <= 0) return;
  await store.saveSummary(conversationId, agentId, summarized.summary, last.id);
}

function bullet(message: Pick<Message, "role" | "content">, contentChars: number): string {
  const who = message.role === "user" ? "User" : "Assistant";
  const text = message.content.replace(/\s+/g, " ").trim().slice(0, Math.max(0, contentChars));
  return `- ${who}: ${text}`;
}

function bulletsAt(
  messages: readonly Pick<Message, "role" | "content">[],
  contentChars: number,
): string[] {
  return messages.map((message) => bullet(message, contentChars));
}

function bulletsFit(lines: readonly string[], budget: number): boolean {
  return estimateTokens(lines.join("\n")) <= budget;
}

function shrinkBullets(
  messages: readonly Pick<Message, "role" | "content">[],
  budget: number,
): { lines: string[]; covered: number } {
  if (messages.length === 0) return { lines: [], covered: 0 };
  const full = bulletsAt(messages, 180);
  if (bulletsFit(full, budget)) return { lines: full, covered: messages.length };

  let bestChars = 0;
  let lo = 0;
  let hi = 179;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (bulletsFit(bulletsAt(messages, mid), budget)) {
      bestChars = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (bulletsFit(bulletsAt(messages, bestChars), budget)) {
    return { lines: bulletsAt(messages, bestChars), covered: messages.length };
  }

  let count = 0;
  for (let size = 1; size <= messages.length; size += 1) {
    if (!bulletsFit(bulletsAt(messages.slice(0, size), 0), budget)) break;
    count = size;
  }
  return { lines: bulletsAt(messages.slice(0, count), 0), covered: count };
}

export function summarizeMessages(
  previous: string | null,
  messages: readonly Pick<Message, "role" | "content">[],
): { summary: string; covered: number } {
  const shrunk = shrinkBullets(messages, SUMMARY_TOKEN_BUDGET);
  const body = shrunk.lines.join("\n");
  const prior = previous?.trim() ?? "";
  if (!prior || shrunk.covered === 0) return { summary: body, covered: shrunk.covered };
  const room = SUMMARY_TOKEN_BUDGET - estimateTokens(body) - (body ? 1 : 0);
  if (room < 8) return { summary: body, covered: shrunk.covered };
  const keptPrior = trimToTokens(prior, room, "end");
  const combined = body ? `${keptPrior}\n${body}` : keptPrior;
  if (estimateTokens(combined) > SUMMARY_TOKEN_BUDGET) {
    return { summary: body, covered: shrunk.covered };
  }
  return { summary: combined, covered: shrunk.covered };
}
