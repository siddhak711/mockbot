import { DEFAULT_AGENT_ID } from "./agent";
import { compactIfNeeded } from "./memory/compact";
import { buildSystemPrompt } from "./memory/prompt";
import { contextTokenLimit, SEARCH_TOP_K } from "./memory/tokens";
import type { ConversationStore } from "./store";
import type { MemoryToolDeps } from "./tools/types";
import type { LlmMessage, Message } from "./types";

export async function buildModelInput(options: {
  store: ConversationStore;
  conversationId: string;
  agentId?: string;
  contextTokens?: number;
}): Promise<{ messages: LlmMessage[]; deps: MemoryToolDeps } | null> {
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
  ];
  for (const message of promptMessages) {
    const rendered = renderTurnMessage(message);
    if (rendered) messages.push(rendered);
  }
  const deps: MemoryToolDeps = {
    agentId,
    conversationId: options.conversationId,
    sourceMessageId: latestUser?.id ?? null,
    userMessages: loaded.messages
      .filter((message) => message.role === "user")
      .map((message) => message.content),
    toolOutputs: [],
  };
  return { messages, deps };
}

function renderTurnMessage(message: Message): LlmMessage | null {
  if (message.role === "user") {
    if (message.content.length === 0) return null;
    return { role: "user", content: message.content };
  }
  const activity = (message.tools ?? [])
    .map((tool) => {
      const output = tool.output ? tool.output.slice(0, 500) : tool.status;
      return `${tool.name} (${tool.status}): ${output}`;
    })
    .join("\n");
  const content = [message.content.trim(), activity ? `Previous tool activity:\n${activity}` : ""]
    .filter(Boolean)
    .join("\n\n");
  if (!content) return null;
  return { role: "assistant", content };
}
