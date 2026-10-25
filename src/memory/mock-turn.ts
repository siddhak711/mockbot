import type { LlmMessage } from "../types";
import { contentWords } from "./grounding";
import { inferKind, keyFromFact, sectionText } from "./prompt";

export type MockPlan =
  | { type: "text"; text: string }
  | { type: "tool"; name: string; args: Record<string, unknown> }
  | { type: "default" };

export function planMockTurn(messages: LlmMessage[], toolNames: ReadonlySet<string>): MockPlan {
  const user = lastUserText(messages);
  const sinceUser = messagesAfterLastUser(messages);
  const toolMessages = sinceUser.filter((message) => message.role === "tool");
  if (toolMessages.length > 0) {
    return {
      type: "text",
      text: closingText(toolMessages[toolMessages.length - 1]?.content ?? ""),
    };
  }
  const command = parseMemoryCommand(user);
  if (command && toolNames.has(command.name)) return command;
  const remembered = answerFromMemory(messages, user);
  if (remembered) return { type: "text", text: remembered };
  return { type: "default" };
}

function lastUserText(messages: LlmMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") return messages[index]?.content ?? "";
  }
  return "";
}

function messagesAfterLastUser(messages: LlmMessage[]): LlmMessage[] {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") return messages.slice(index + 1);
  }
  return messages;
}

function parseMemoryCommand(user: string): Extract<MockPlan, { type: "tool" }> | null {
  const update = user.match(/^(?:please\s+)?update(?:\s+the)?\s+memory\s+(.+?)\s+to\s+(.+)$/is);
  if (update?.[1] && update[2]) {
    return {
      type: "tool",
      name: "memory_update",
      args: { key: keyFromFact(update[1]), text: update[2].trim(), kind: inferKind(update[2]) },
    };
  }
  const forget = user.match(
    /^(?:please\s+)?(?:forget|delete)(?:\s+the)?(?:\s+memory)?(?:\s+(?:that|about))?\s+(.+)$/is,
  );
  if (forget?.[1]) {
    return { type: "tool", name: "memory_delete", args: { key: keyFromFact(forget[1]) } };
  }
  const search = user.match(
    /^(?:please\s+)?(?:search(?:\s+your)?\s+memories?(?:\s+for)?|what do you remember(?:\s+about)?)\s+(.+)$/is,
  );
  if (search?.[1]) {
    return { type: "tool", name: "memory_search", args: { query: search[1].trim() } };
  }
  const remember = user.match(
    /^(?:please\s+)?(?:remember|don'?t forget|do not forget)(?:\s+that)?\s+(.+)$/is,
  );
  if (remember?.[1]) {
    const text = remember[1].trim();
    return {
      type: "tool",
      name: "memory_write",
      args: { key: keyFromFact(text), text, kind: inferKind(text) },
    };
  }
  return null;
}

function answerFromMemory(messages: LlmMessage[], user: string): string | null {
  if (!/[?]|\b(what|who|where|when|which|remember|know)\b/i.test(user)) return null;
  const system = messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n");
  const block = [sectionText(system, "profile-memories"), sectionText(system, "recalled-facts")]
    .filter(Boolean)
    .join("\n");
  if (!block) return null;
  const lines = block
    .split("\n")
    .map((line) => line.replace(/^- /, "").trim())
    .filter(Boolean);
  let best: { line: string; score: number } | null = null;
  const userWords = new Set(contentWords(user));
  for (const line of lines) {
    let score = 0;
    for (const word of contentWords(line)) {
      if (userWords.has(word)) score += 1;
    }
    if (!best || score > best.score) best = { line, score };
  }
  if (!best || best.score < 1) return null;
  return `I remember this: ${best.line}`;
}

function closingText(output: string): string {
  const text = output.trim();
  if (/^(?:Saved|Updated) memory "/.test(text)) return "I'll remember that.";
  if (/^Forgot "/.test(text)) return "I forgot that.";
  if (text.startsWith("Blocked.") && /not stored/i.test(text)) {
    return "I did not save that. It looked like a secret, so it was not stored.";
  }
  if (text.startsWith("Not saved.")) {
    return "I did not save that, because I only store what you say yourself.";
  }
  if (text.startsWith("No memory with that key")) return "I don't have a memory with that key yet.";
  if (text.startsWith("The user denied this action") || text.startsWith("Approval timed out")) {
    return "I did not do that. It was not approved.";
  }
  if (text.startsWith("No matching memories.")) return "I don't have a matching memory.";
  if (/^- .+: /m.test(text)) return `Here is what I found in memory:\n\n${text}`;
  return text || "Done.";
}
