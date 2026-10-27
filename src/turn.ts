import { DEFAULT_AGENT_ID } from "./agent";
import { compactIfNeeded, messagePromptText } from "./memory/compact";
import { AGENT_RULES, BASE_SYSTEM_PROMPT, memorySections, SYSTEM_PROMPT } from "./memory/prompt";
import { contextTokenLimit, SEARCH_TOP_K } from "./memory/tokens";
import type { ConversationStore } from "./store";
import type { MemoryToolDeps } from "./tools/types";
import type { LlmMessage, Message } from "./types";

function withSections(prefix: string, sections: string): string {
  return sections ? `${prefix}\n\n${sections}` : prefix;
}

function systemContent(agentPrompt: string | undefined, sections: string): string {
  const lead = withSections(BASE_SYSTEM_PROMPT, sections);
  if (!agentPrompt || agentPrompt === SYSTEM_PROMPT || agentPrompt === BASE_SYSTEM_PROMPT) {
    return lead;
  }
  if (agentPrompt.startsWith(`${SYSTEM_PROMPT}\n`)) {
    const agentExtra = agentPrompt.slice(SYSTEM_PROMPT.length).replace(/^\n+/, "");
    return agentExtra ? `${lead}\n\n${agentExtra}` : lead;
  }
  return withSections(`${agentPrompt}\n\n${AGENT_RULES}`, sections);
}

export async function buildModelInput(options: {
  store: ConversationStore;
  conversationId: string;
  agentId?: string;
  agentPrompt?: string;
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
  const sections = memorySections({ profiles, facts, summary });
  const messages: LlmMessage[] = [
    { role: "system", content: systemContent(options.agentPrompt, sections) },
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
  const content = messagePromptText(message);
  if (!content) return null;
  const failed =
    message.role !== "user" &&
    (message.tools?.some((tool) => tool.status === "error") === true ||
      message.trace?.route?.reason === "retry");
  return {
    role: message.role === "user" ? "user" : "assistant",
    content,
    ...(failed ? { failed: true } : {}),
  };
}

/**
 * Drop a user message that never got an assistant reply. A failed unattended
 * run can leave one behind, and the next run must not send it as history. The
 * newest user message is this turn's prompt, so it stays.
 */
export function dropAbandonedPrompts(messages: LlmMessage[]): LlmMessage[] {
  return messages.filter((message, index) => {
    if (message.role !== "user") return true;
    for (let next = index + 1; next < messages.length; next += 1) {
      const later = messages[next];
      if (!later || later.role === "system") continue;
      if (later.role === "user") return false;
      return true;
    }
    return true;
  });
}
