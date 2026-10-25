import type { LlmProvider } from "../llm";
import type { LlmMessage, LlmStreamEvent } from "../types";
import { DELEGATE_TOOL_NAME, USE_COMPUTER_TOOL } from "./ids";

export type LiveTool = {
  id: string;
  name: string;
  arguments: string;
};

const DELEGATE_PHRASE = /^delegate to\s+([^:\n]+?)\s*:\s*([\s\S]+)$/i;

export function parseDelegatePhrase(text: string): { agent: string; task: string } | null {
  const match = text.trim().match(DELEGATE_PHRASE);
  const agent = match?.[1]?.trim() ?? "";
  const task = match?.[2]?.trim() ?? "";
  if (!agent || !task) return null;
  return { agent, task };
}

function systemOf(messages: readonly LlmMessage[]): string {
  return messages.find((message) => message.role === "system")?.content ?? "";
}

function lastUser(messages: readonly LlmMessage[]): string {
  return [...messages].reverse().find((message) => message.role === "user")?.content ?? "";
}

export function renderScopedMockReply(messages: readonly LlmMessage[]): string {
  const system = systemOf(messages);
  const task = lastUser(messages).replace(/\s+/g, " ").trim();
  const name = system.match(/^name: (.+)$/m)?.[1]?.trim() || "Agent";
  const persona = system.split("\n\n# Agent")[0]?.trim() ?? "";
  const clipped = persona.length > 500 ? `${persona.slice(0, 499)}…` : persona;
  const memoryBlock = system.split("memories:\n")[1]?.split(/\n(?:computers:|connectors:|Use )/)[0];
  const lines = [`**${name}**`, "", clipped, "", `Task: ${task}`];
  const notes = memoryBlock?.trim();
  if (notes) lines.push("", "Notes:", notes);
  return lines.join("\n");
}

export function scriptLiveTurn(
  messages: readonly LlmMessage[],
): { reasoning: string; tools: LiveTool[]; reply?: string } | null {
  const system = systemOf(messages);
  const child = system.includes("delegation: child");
  if (child) {
    const listed = system.match(/^computers: (.+)$/m)?.[1] ?? "";
    const computerId = listed
      .split(",")
      .map((part) => part.trim())
      .find(Boolean);
    const tools: LiveTool[] = [];
    if (computerId) {
      tools.push({
        id: "call_computer",
        name: USE_COMPUTER_TOOL,
        arguments: JSON.stringify({ computerId, path: "notes.txt" }),
      });
    }
    return {
      reasoning: "This turn stays on my own instructions, notes, and grants.",
      tools,
      reply: renderScopedMockReply(messages),
    };
  }

  const phrase = parseDelegatePhrase(lastUser(messages));
  if (phrase) {
    return {
      reasoning: `Hand this subtask to ${phrase.agent}.`,
      tools: [
        {
          id: "call_delegate",
          name: DELEGATE_TOOL_NAME,
          arguments: JSON.stringify({ agent: phrase.agent, task: phrase.task }),
        },
      ],
    };
  }

  if (system.includes("\n# Agent\n")) {
    return {
      reasoning: "Reply with this agent's own instructions and notes.",
      tools: [],
      reply: renderScopedMockReply(messages),
    };
  }

  return null;
}

/** Wraps the live mock so a delegate phrase and a child turn are deterministic. */
export function withAgentMock(provider: LlmProvider): LlmProvider {
  if (provider.id !== "mock") return provider;
  return {
    id: "mock",
    model: provider.model,
    async *stream(messages: LlmMessage[], signal?: AbortSignal): AsyncIterable<LlmStreamEvent> {
      const script = scriptLiveTurn(messages);
      if (!script) {
        yield* provider.stream(messages, signal);
        return;
      }
      if (signal?.aborted) return;
      yield { type: "start", role: "assistant" };
      yield { type: "reasoning", text: script.reasoning };
      for (let index = 0; index < script.tools.length; index += 1) {
        const tool = script.tools[index];
        if (!tool) continue;
        yield {
          type: "tool_call",
          index,
          id: tool.id,
          name: tool.name,
          arguments: tool.arguments,
        };
      }
      if (script.reply !== undefined) {
        yield { type: "text", text: script.reply };
        yield { type: "end", finishReason: "stop" };
        return;
      }
      yield { type: "end", finishReason: "tool_calls" };
    },
  };
}
