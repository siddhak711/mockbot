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
  const last = older[older.length - 1];
  if (!last) return;
  const nextSummary = summarizeMessages(summary?.summary ?? null, older);
  await store.saveSummary(conversationId, agentId, nextSummary, last.id);
}

export function summarizeMessages(previous: string | null, messages: readonly Message[]): string {
  const bullets = messages.map((message) => {
    const who = message.role === "user" ? "User" : "Assistant";
    const text = message.content.replace(/\s+/g, " ").trim().slice(0, 180);
    return `- ${who}: ${text}`;
  });
  const combined = [previous?.trim(), ...bullets].filter(Boolean).join("\n");
  return trimToTokens(combined, SUMMARY_TOKEN_BUDGET);
}
