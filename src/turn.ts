import { DEFAULT_AGENT_ID } from "./agent";
import { compactIfNeeded } from "./memory/compact";
import { buildSystemPrompt } from "./memory/prompt";
import { contextTokenLimit, SEARCH_TOP_K } from "./memory/tokens";
import type { ConversationStore } from "./store";
import { createMemoryTools } from "./tools/memory";
import { ToolRegistry } from "./tools/registry";
import type { MemoryToolDeps, ToolDefinition } from "./tools/types";
import type { LlmMessage } from "./types";

export async function buildModelInput(options: {
  store: ConversationStore;
  conversationId: string;
  agentId?: string;
  contextTokens?: number;
}): Promise<{ messages: LlmMessage[]; tools: ToolDefinition[]; deps: MemoryToolDeps } | null> {
  const agentId = options.agentId ?? DEFAULT_AGENT_ID;
  const contextTokens = options.contextTokens ?? contextTokenLimit(process.env);
  await compactIfNeeded(options.store, options.conversationId, agentId, contextTokens);
  const loaded = await options.store.getConversation(options.conversationId, agentId);
  if (!loaded) return null;
  const summary = await options.store.getSummary(options.conversationId, agentId);
  const profiles = await options.store.memories.listLive(agentId, "profile");
  const latestUser = [...loaded.messages].reverse().find((message) => message.role === "user");
  const facts = latestUser
    ? await options.store.memories.search({
        agentId,
        query: latestUser.content,
        kind: "fact",
        limit: SEARCH_TOP_K,
      })
    : [];
  let promptMessages = loaded.messages;
  if (summary?.uptoMessageId) {
    const covered = promptMessages.findIndex((message) => message.id === summary.uptoMessageId);
    if (covered >= 0) promptMessages = promptMessages.slice(covered + 1);
  }
  const messages: LlmMessage[] = [
    { role: "system", content: buildSystemPrompt({ profiles, facts, summary }) },
    ...promptMessages
      .filter((message) => message.content.length > 0)
      .map((message) => ({ role: message.role, content: message.content })),
  ];
  const deps: MemoryToolDeps = {
    agentId,
    conversationId: options.conversationId,
    sourceMessageId: latestUser?.id ?? null,
    userMessages: loaded.messages
      .filter((message) => message.role === "user")
      .map((message) => message.content),
    toolOutputs: [],
  };
  const registry = new ToolRegistry();
  for (const tool of createMemoryTools(options.store, deps)) registry.register(tool);
  return { messages, tools: registry.exposed(), deps };
}
