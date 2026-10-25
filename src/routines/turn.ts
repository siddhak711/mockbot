import { SYSTEM_PROMPT, type LlmProvider } from "../llm";
import type { ConversationStore } from "../store";
import { applyStreamEvent, emptyTrace } from "../trace";
import type { LlmMessage } from "../types";

/**
 * The only place a routine invokes the agent loop.
 * It stores the prompt and the finished reply on the routine's conversation.
 * Later milestones can replace this with the shared tool loop.
 */
export async function runRoutineTurn(options: {
  store: ConversationStore;
  provider: LlmProvider;
  conversationId: string;
  prompt: string;
}): Promise<{ assistantMessageId: string; text: string }> {
  await options.store.addMessage(options.conversationId, "user", options.prompt);
  const stored = await options.store.getConversation(options.conversationId);
  if (!stored) throw new Error("Conversation disappeared before the routine ran");
  const history: LlmMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    ...stored.messages
      .filter((message) => message.content.length > 0)
      .map((message) => ({ role: message.role, content: message.content })),
  ];
  let trace = emptyTrace();
  for await (const event of options.provider.stream(history)) {
    trace = applyStreamEvent(trace, event);
  }
  const assistant = await options.store.addMessage(
    options.conversationId,
    "assistant",
    trace.text,
    trace,
  );
  return { assistantMessageId: assistant.id, text: trace.text };
}

export function promptForRun(
  prompt: string,
  event: { name: string; payload: string | null } | null,
): string {
  if (!event?.payload) return prompt;
  return `${prompt}\n\nEvent ${event.name}:\n${event.payload}`;
}
