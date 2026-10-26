import type { LlmStreamEvent } from "./types";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  return value as Record<string, unknown>;
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return "";
}

function readText(value: unknown): string {
  if (typeof value === "string") return value;
  const record = asRecord(value);
  if (!record) return "";
  return firstString(record.text, record.content, record.reasoning, record.thinking);
}

function pushToolCall(
  events: LlmStreamEvent[],
  call: { index: number; id?: string; name?: string; arguments?: string },
) {
  if (!call.id && !call.name && !call.arguments) return;
  events.push({
    type: "tool_call",
    index: call.index,
    ...(call.id ? { id: call.id } : {}),
    ...(call.name ? { name: call.name } : {}),
    ...(call.arguments ? { arguments: call.arguments } : {}),
  });
}

function readToolCalls(value: unknown, events: LlmStreamEvent[]) {
  if (!Array.isArray(value)) return;
  for (const item of value) {
    const record = asRecord(item);
    if (!record) continue;
    const fn = asRecord(record.function);
    const args = fn && typeof fn.arguments === "string" ? fn.arguments : "";
    pushToolCall(events, {
      index: typeof record.index === "number" ? record.index : 0,
      ...(typeof record.id === "string" && record.id ? { id: record.id } : {}),
      ...(fn && typeof fn.name === "string" && fn.name ? { name: fn.name } : {}),
      ...(args ? { arguments: args } : {}),
    });
  }
}

function readContent(value: unknown, events: LlmStreamEvent[]) {
  if (typeof value === "string") {
    if (value) events.push({ type: "text", text: value });
    return;
  }
  if (!Array.isArray(value)) return;
  for (const item of value) {
    const record = asRecord(item);
    if (!record) continue;
    const text = readText(item);
    if (!text) continue;
    const type = typeof record.type === "string" ? record.type : "";
    if (type === "reasoning" || type === "thinking" || type === "reasoning_text") {
      events.push({ type: "reasoning", text });
    } else {
      events.push({ type: "text", text });
    }
  }
}

function readReasoning(delta: Record<string, unknown>, events: LlmStreamEvent[]) {
  const direct = firstString(
    readText(delta.reasoning_content),
    readText(delta.reasoning),
    readText(delta.thinking),
  );
  if (direct) {
    events.push({ type: "reasoning", text: direct });
    return;
  }
  if (!Array.isArray(delta.reasoning_details)) return;
  for (const item of delta.reasoning_details) {
    const text = readText(item);
    if (text) events.push({ type: "reasoning", text });
  }
}

function readCount(value: unknown): number | null {
  const parsed =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.round(parsed);
}

/** Token counts from an OpenAI-compatible chunk. Prefers prompt/completion, then total. */
export function readModelUsage(
  payload: unknown,
): { inputTokens: number; outputTokens: number } | null {
  const usage = asRecord(asRecord(payload)?.usage);
  if (!usage) return null;
  const input = readCount(usage.prompt_tokens ?? usage.input_tokens);
  const output = readCount(usage.completion_tokens ?? usage.output_tokens);
  if (input == null && output == null) {
    const total = readCount(usage.total_tokens);
    if (total == null) return null;
    return { inputTokens: total, outputTokens: 0 };
  }
  return { inputTokens: input ?? 0, outputTokens: output ?? 0 };
}

export function readOpenAiEvents(payload: unknown): LlmStreamEvent[] {
  const record = asRecord(payload);
  if (!record || !Array.isArray(record.choices)) return [];
  const choice = asRecord(record.choices[0]);
  if (!choice) return [];
  const delta = asRecord(choice.delta);
  const events: LlmStreamEvent[] = [];
  if (delta) {
    if (delta.role === "assistant") events.push({ type: "start", role: "assistant" });
    readReasoning(delta, events);
    readToolCalls(delta.tool_calls, events);
    const legacy = asRecord(delta.function_call);
    if (legacy) {
      const args = typeof legacy.arguments === "string" ? legacy.arguments : "";
      pushToolCall(events, {
        index: 0,
        ...(typeof legacy.name === "string" && legacy.name ? { name: legacy.name } : {}),
        ...(args ? { arguments: args } : {}),
      });
    }
    readContent(delta.content, events);
    if (typeof delta.refusal === "string" && delta.refusal) {
      events.push({ type: "text", text: delta.refusal });
    }
  }
  if (typeof choice.finish_reason === "string" && choice.finish_reason) {
    events.push({ type: "end", finishReason: choice.finish_reason });
  }
  return events;
}
