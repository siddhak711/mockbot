import type { Message, TraceSegment } from "./types";

export type RawToolActivity = {
  id: string;
  messageId: string;
  name: string;
  arguments: string;
  output: string;
};

type ResolvedTool = {
  index: number;
  id: string;
  name: string;
  input: string;
  output: string | null;
};

function section(label: string, body: string): string {
  return `[${label}]\n${body}`;
}

function longer(...values: string[]): string {
  return values.reduce((best, value) => (value.length > best.length ? value : best), "");
}

function preferFull(values: Array<string | null | undefined>): string | null {
  let best: string | null = null;
  for (const value of values) {
    if (typeof value !== "string") continue;
    if (best == null || value.length > best.length) best = value;
  }
  return best;
}

function resolveTools(message: Message, activities: readonly RawToolActivity[]): ResolvedTool[] {
  const resolved: ResolvedTool[] = [];
  const seen = new Set<string>();

  const remember = (tool: ResolvedTool) => {
    if (tool.id && seen.has(tool.id)) {
      const existing = resolved.find((item) => item.id === tool.id);
      if (!existing) return;
      existing.name = longer(existing.name, tool.name);
      existing.input = longer(existing.input, tool.input);
      existing.output = preferFull([existing.output, tool.output]);
      return;
    }
    if (tool.id) seen.add(tool.id);
    resolved.push(tool);
  };

  for (const tool of message.trace?.tools ?? []) {
    const activity = activities.find(
      (item) => item.messageId === message.id && item.id === tool.id,
    );
    const stored = message.tools?.find((item) => item.id === tool.id);
    remember({
      index: tool.index,
      id: tool.id,
      name: longer(tool.name, activity?.name ?? "", stored?.name ?? ""),
      input: longer(tool.arguments, activity?.arguments ?? "", stored?.arguments ?? ""),
      output: preferFull([tool.result, stored?.output, activity?.output]),
    });
  }

  let extra = resolved.reduce((max, tool) => Math.max(max, tool.index), -1);
  for (const stored of message.tools ?? []) {
    extra += 1;
    remember({
      index: extra,
      id: stored.id,
      name: stored.name,
      input: stored.arguments,
      output: stored.output,
    });
  }
  for (const activity of activities) {
    if (activity.messageId !== message.id) continue;
    extra += 1;
    remember({
      index: extra,
      id: activity.id,
      name: activity.name,
      input: activity.arguments,
      output: activity.output,
    });
  }
  return resolved;
}

function formatTool(tool: ResolvedTool): string {
  const lines = [`[TOOL CALL: ${tool.name || "tool"}]`];
  if (tool.id) lines.push(`id: ${tool.id}`);
  lines.push("input:", tool.input, "output:", tool.output ?? "");
  return lines.join("\n");
}

function assistantBlocks(message: Message, activities: readonly RawToolActivity[]): string[] {
  const tools = resolveTools(message, activities);
  const trace = message.trace;
  const segments = trace?.segments ?? [];
  const text = longer(message.content, trace?.text ?? "");
  const blocks: string[] = [];

  if (segments.length > 0) {
    return blocksFromSegments(segments, tools, text);
  }

  if (trace?.reasoning) blocks.push(section("ASSISTANT reasoning", trace.reasoning));
  for (const tool of tools) blocks.push(formatTool(tool));
  if (text) blocks.push(section("ASSISTANT text", text));
  return blocks;
}

function blocksFromSegments(
  segments: readonly TraceSegment[],
  tools: readonly ResolvedTool[],
  text: string,
): string[] {
  const blocks: string[] = [];
  const used = new Set<number>();
  let renderedText = "";
  for (const segment of segments) {
    if (segment.type === "reasoning") {
      blocks.push(section("ASSISTANT reasoning", segment.text));
      continue;
    }
    if (segment.type === "text") {
      renderedText += segment.text;
      blocks.push(section("ASSISTANT text", segment.text));
      continue;
    }
    const tool = tools.find((item) => item.index === segment.index);
    if (!tool || used.has(segment.index)) continue;
    used.add(segment.index);
    blocks.push(formatTool(tool));
  }
  for (const tool of tools) {
    if (used.has(tool.index)) continue;
    blocks.push(formatTool(tool));
  }
  if (text.startsWith(renderedText)) {
    const rest = text.slice(renderedText.length);
    if (rest) blocks.push(section("ASSISTANT text", rest));
  } else if (text && !renderedText.includes(text)) {
    blocks.push(section("ASSISTANT text", text));
  }
  return blocks;
}

function assistantAfter(messages: readonly Message[], index: number): Message | undefined {
  for (let cursor = index + 1; cursor < messages.length; cursor += 1) {
    const message = messages[cursor];
    if (!message) continue;
    if (message.role === "user") return undefined;
    return message;
  }
  return undefined;
}

/**
 * One plain-text transcript of everything the model saw and produced.
 * Nothing is truncated. Sections stay in conversation order.
 */
export function renderRawTranscript(
  messages: readonly Message[],
  activities: readonly RawToolActivity[] = [],
): string {
  const blocks: string[] = [];
  let shownSystem: string | undefined;
  const prefillShown = new Set<string>();

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message) continue;
    if (message.role === "user") {
      const next = assistantAfter(messages, index);
      const system = next?.trace?.system ?? "";
      if (system && system !== shownSystem) {
        blocks.push(section("SYSTEM", system));
        shownSystem = system;
      }
      blocks.push(section("USER", message.content));
      const prefill = next?.trace?.prefill ?? "";
      if (next && prefill && !prefillShown.has(next.id)) {
        blocks.push(section("PREFILL", prefill));
        prefillShown.add(next.id);
      }
      continue;
    }

    const system = message.trace?.system ?? "";
    if (system && system !== shownSystem) {
      blocks.push(section("SYSTEM", system));
      shownSystem = system;
    }
    const prefill = message.trace?.prefill ?? "";
    if (prefill && !prefillShown.has(message.id)) {
      blocks.push(section("PREFILL", prefill));
      prefillShown.add(message.id);
    }
    blocks.push(...assistantBlocks(message, activities));
  }

  return blocks.join("\n\n");
}
