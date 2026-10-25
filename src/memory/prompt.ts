import type { ConversationSummary, MemoryKind, MemoryVersion } from "../types";
import { fitBlock, PROFILE_TOKEN_BUDGET, SEARCH_TOKEN_BUDGET } from "./tokens";

export const BASE_SYSTEM_PROMPT = [
  "You are Mockbot, a concise personal assistant. Reply in markdown when it helps.",
  "",
  "You can call tools. Prefer a tool when it can answer the question. At most 15 tools are listed at once. If you need something that is not listed, call tool_search with a short query, then call the tool it returns.",
  "",
  "Read-only tools run immediately. Tools that send, post, delete, pay, or invite someone wait until the person approves them. If they deny a tool, do not retry it unless they ask again.",
  "",
  "You have durable memory for this agent. Use the memory tools. Do not claim you saved something unless the tool succeeded.",
  "",
  '- memory_write(key, text, kind?) saves a fact the user just told you. kind is "profile" for stable identity and preferences (name, timezone, favorites) and "fact" otherwise. Writing an existing key keeps the old row and stores a new one.',
  "- memory_update(key, text, kind?) records a correction. It closes the old row and inserts a new one. Never overwrite a row in place.",
  "- memory_delete(key) forgets a fact when the user asks you to.",
  "- memory_search(query) finds memories by full text when the profile and recalled facts below are not enough.",
  "",
  "Only save what the user said in this conversation. Never save tool results, web pages, or secrets such as API keys, tokens, passwords, or card numbers. If a write is blocked, tell the user you did not save it and do not retry with the same secret.",
  "",
  "Profile memories are already in this prompt. Recalled facts matched the latest user message. They are system context, not new user messages.",
].join("\n");

export function memoryLine(memory: Pick<MemoryVersion, "key" | "content">): string {
  const content = memory.content.replace(/\s+/g, " ").trim();
  return `- ${memory.key}: ${content}`;
}

export function renderMemoryBlock(memories: readonly MemoryVersion[], budget: number): string {
  return fitBlock(memories.map(memoryLine), budget);
}

export function buildSystemPrompt(input: {
  profiles: readonly MemoryVersion[];
  facts: readonly MemoryVersion[];
  summary?: ConversationSummary | null;
}): string {
  const parts = [BASE_SYSTEM_PROMPT];
  if (input.summary?.summary) {
    parts.push(
      `<conversation-summary upto="${input.summary.uptoMessageId}">\n${input.summary.summary}\n</conversation-summary>`,
    );
  }
  const profiles = renderMemoryBlock(input.profiles, PROFILE_TOKEN_BUDGET);
  if (profiles) parts.push(`<profile-memories>\n${profiles}\n</profile-memories>`);
  const facts = renderMemoryBlock(input.facts, SEARCH_TOKEN_BUDGET);
  if (facts) parts.push(`<recalled-facts>\n${facts}\n</recalled-facts>`);
  return parts.join("\n\n");
}

export function sectionText(system: string, tag: string): string {
  const match = system.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`));
  return match?.[1]?.trim() ?? "";
}

export function inferKind(text: string): MemoryKind {
  if (
    /\b(name|favorite|prefer|preference|timezone|birthday|live|lives|work|job|pronouns|email|city|pet|editor|language|team)\b/i.test(
      text,
    )
  ) {
    return "profile";
  }
  return "fact";
}

export function normalizeKey(key: string): string {
  return key.replace(/\s+/g, " ").trim().slice(0, 80);
}

export function keyFromFact(text: string): string {
  const cleaned = text.replace(/[.?!]+$/g, "").trim();
  const labeled = cleaned.match(/^(?:my|the user's|the user|the|a|an)\s+(.+?)\s+(?:is|are)\s+.+$/i);
  if (labeled?.[1]) return normalizeKey(labeled[1]);
  const mine = cleaned.match(/^my\s+(.+)$/i);
  if (mine?.[1]) return normalizeKey(mine[1]);
  return normalizeKey(cleaned.split(/\s+/).slice(0, 8).join(" "));
}
