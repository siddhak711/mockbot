import type { LlmMessage } from "../types";
import { contentWords } from "./grounding";
import { inferKind, keyFromFact, sectionText } from "./prompt";
import { findSecrets } from "./scrub";

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
      text: closingText(user, toolMessages[toolMessages.length - 1]?.content ?? ""),
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

function closingText(user: string, output: string): string {
  if (findSecrets(output).length > 0 || /blocked|not stored|secret/i.test(output)) {
    return "I did not save that. It looked like a secret, so it was not stored.";
  }
  if (/not saved|tool and web output/i.test(output)) {
    return "I did not save that, because I only store what you say yourself.";
  }
  if (/no memory with that key/i.test(output)) return "I don't have a memory with that key yet.";
  if (/forgot/i.test(output)) return "I forgot that.";
  const command = parseMemoryCommand(user);
  if (command?.name === "memory_write" || command?.name === "memory_update") {
    const text = typeof command.args.text === "string" ? command.args.text : "";
    return text ? `I'll remember that: ${text}` : "I'll remember that.";
  }
  if (command?.name === "memory_search") return `Here is what I found in memory:\n\n${output}`;
  if (command?.name === "memory_delete") return "I forgot that.";
  return "Done.";
}
