import type { LlmStreamEvent } from "../types";
import { DELEGATE_TOOL_NAME } from "./ids";

type OpenCall = {
  index: number;
  id: string;
  name: string;
  arguments: string;
};

function mergeName(current: string, chunk: string): string {
  if (!chunk) return current;
  if (!current || chunk === current) return chunk;
  if (chunk.startsWith(current)) return chunk;
  return current + chunk;
}

function agentLabel(raw: string): string {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const agent = (parsed as { agent?: unknown }).agent;
      if (typeof agent === "string" && agent.trim()) return agent.trim();
    }
  } catch {
    return "the other agent";
  }
  return "the other agent";
}

/**
 * Runs a completed `delegate` tool call and yields its result before the parent continues.
 * Other tool calls pass through untouched.
 */
export async function* runWithDelegate(
  source: AsyncIterable<LlmStreamEvent>,
  delegate: (call: { id: string; arguments: string }) => Promise<string>,
): AsyncIterable<LlmStreamEvent> {
  let current: OpenCall | null = null;
  let sawText = false;
  let closing: string | null = null;
  const done = new Set<string>();

  const settle = async function* (call: OpenCall, final: boolean): AsyncGenerator<LlmStreamEvent> {
    if (call.name !== DELEGATE_TOOL_NAME) return;
    const key = call.id || String(call.index);
    if (done.has(key)) return;
    let parsed = false;
    if (call.arguments.trim()) {
      try {
        JSON.parse(call.arguments);
        parsed = true;
      } catch {
        parsed = false;
      }
    }
    if (!parsed && !final) return;
    done.add(key);
    const content = parsed
      ? await delegate({ id: call.id, arguments: call.arguments })
      : "Delegation failed: arguments are not JSON.";
    yield { type: "tool_result", id: call.id, name: DELEGATE_TOOL_NAME, content };
    if (!sawText) {
      closing = content.startsWith("Delegation failed")
        ? "The handoff failed. This conversation can continue."
        : `Delegated to ${agentLabel(call.arguments)}.`;
    }
  };

  for await (const event of source) {
    if (event.type === "tool_call") {
      if (!current || current.index !== event.index) {
        if (current) yield* settle(current, false);
        current = {
          index: event.index,
          id: event.id ?? "",
          name: event.name ?? "",
          arguments: event.arguments ?? "",
        };
      } else {
        if (event.id && !current.id) current.id = event.id;
        if (event.name) current.name = mergeName(current.name, event.name);
        if (event.arguments) current.arguments += event.arguments;
      }
      yield event;
      continue;
    }

    if (current) {
      yield* settle(current, event.type === "end");
      current = null;
    }

    if (event.type === "tool_result" && event.name === DELEGATE_TOOL_NAME && done.has(event.id)) {
      continue;
    }

    if (event.type === "text" && event.text) sawText = true;

    if (event.type === "end" && !sawText && closing) {
      sawText = true;
      yield { type: "text", text: closing };
      closing = null;
    }

    yield event;
  }

  if (current) yield* settle(current, true);
  if (!sawText && closing) yield { type: "text", text: closing };
}

/**
 * Like `runWithDelegate`, but a round that also proposes a plan does not start
 * the delegate call. The plan gate has not approved anything yet.
 * Delegate calls are settled at the end of the round, once that is known.
 */
export async function* runWithDelegateUnlessPlan(
  source: AsyncIterable<LlmStreamEvent>,
  delegate: (call: { id: string; arguments: string }) => Promise<string>,
  planToolName: string,
): AsyncIterable<LlmStreamEvent> {
  const calls = new Map<number, OpenCall>();
  let planning = false;
  let sawText = false;
  let settled = false;

  const flush = async function* (): AsyncGenerator<LlmStreamEvent> {
    if (settled || planning) return;
    settled = true;
    let closing: string | null = null;
    const ordered = [...calls.values()].sort((left, right) => left.index - right.index);
    for (const call of ordered) {
      if (call.name !== DELEGATE_TOOL_NAME) continue;
      let parsed = false;
      if (call.arguments.trim()) {
        try {
          JSON.parse(call.arguments);
          parsed = true;
        } catch {
          parsed = false;
        }
      }
      const content = parsed
        ? await delegate({ id: call.id, arguments: call.arguments })
        : "Delegation failed: arguments are not JSON.";
      yield { type: "tool_result", id: call.id, name: DELEGATE_TOOL_NAME, content };
      if (!sawText) {
        closing = content.startsWith("Delegation failed")
          ? "The handoff failed. This conversation can continue."
          : `Delegated to ${agentLabel(call.arguments)}.`;
      }
    }
    if (!sawText && closing) yield { type: "text", text: closing };
  };

  for await (const event of source) {
    if (event.type === "tool_call") {
      const current = calls.get(event.index) ?? {
        index: event.index,
        id: "",
        name: "",
        arguments: "",
      };
      if (event.id && !current.id) current.id = event.id;
      if (event.name) current.name = mergeName(current.name, event.name);
      if (event.arguments) current.arguments += event.arguments;
      calls.set(event.index, current);
      if (current.name === planToolName) planning = true;
      yield event;
      continue;
    }
    if (event.type === "text" && event.text) sawText = true;
    if (event.type === "end") {
      yield* flush();
      yield event;
      continue;
    }
    yield event;
  }
  yield* flush();
}
