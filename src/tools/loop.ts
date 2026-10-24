import type { LlmProvider, ProviderEvent } from "../llm";
import type { LlmMessage, LlmToolCall } from "../types";
import type { ToolDefinition } from "./types";

export const MAX_TOOL_STEPS = 4;

export type FinishedToolCall = {
  id: string;
  name: string;
  arguments: string;
  output: string;
  isError: boolean;
};

export async function runToolLoop(options: {
  provider: LlmProvider;
  messages: LlmMessage[];
  tools: readonly ToolDefinition[];
  signal?: AbortSignal;
  maxSteps?: number;
  onText: (text: string) => Promise<void>;
  onTool: (call: FinishedToolCall, phase: "running" | "done") => void;
  execute: (call: { id: string; name: string; arguments: string }) => Promise<{
    output: string;
    isError: boolean;
  }>;
}): Promise<{ text: string; toolCalls: number; capped: boolean }> {
  const history = options.messages.map((message) => ({ ...message }));
  const maxSteps = options.maxSteps ?? MAX_TOOL_STEPS;
  let text = "";
  let toolCalls = 0;
  for (let step = 0; step < maxSteps; step += 1) {
    if (options.signal?.aborted) break;
    const calls: Array<{ id: string; name: string; arguments: string }> = [];
    let roundText = "";
    for await (const event of providerEvents(
      options.provider,
      history,
      options.tools,
      options.signal,
    )) {
      if (options.signal?.aborted) break;
      if (event.type === "text") {
        if (!event.text) continue;
        text += event.text;
        roundText += event.text;
        await options.onText(event.text);
        continue;
      }
      let call = calls.find((item) => item.id === event.id);
      if (!call) {
        call = { id: event.id, name: event.name ?? "", arguments: "" };
        calls.push(call);
      }
      if (event.name) call.name = event.name;
      call.arguments += event.argumentsDelta;
    }
    if (options.signal?.aborted || calls.length === 0) {
      return { text, toolCalls, capped: false };
    }
    history.push({
      role: "assistant",
      content: roundText,
      tool_calls: calls.map(toLlmToolCall),
    });
    for (const call of calls) {
      if (options.signal?.aborted) break;
      options.onTool({ ...call, output: "", isError: false }, "running");
      const result = await options.execute(call);
      toolCalls += 1;
      const finished = { ...call, output: result.output, isError: result.isError };
      options.onTool(finished, "done");
      history.push({ role: "tool", tool_call_id: call.id, content: result.output });
    }
  }
  return { text, toolCalls, capped: toolCalls > 0 };
}

async function* providerEvents(
  provider: LlmProvider,
  messages: LlmMessage[],
  tools: readonly ToolDefinition[],
  signal?: AbortSignal,
): AsyncIterable<ProviderEvent> {
  if (provider.streamEvents) {
    yield* provider.streamEvents(messages, { tools, signal });
    return;
  }
  for await (const text of provider.stream(messages, signal)) {
    if (text) yield { type: "text", text };
  }
}

function toLlmToolCall(call: { id: string; name: string; arguments: string }): LlmToolCall {
  return {
    id: call.id,
    type: "function",
    function: { name: call.name, arguments: call.arguments || "{}" },
  };
}

export function parseToolArguments(
  raw: string,
): { ok: true; args: Record<string, unknown> } | { ok: false; error: string } {
  const text = raw.trim() ? raw : "{}";
  try {
    const value = JSON.parse(text) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { ok: false, error: "Tool arguments must be a JSON object." };
    }
    return { ok: true, args: value as Record<string, unknown> };
  } catch {
    return { ok: false, error: "Tool arguments were not valid JSON." };
  }
}

export async function executeRegisteredTool(
  tools: readonly ToolDefinition[],
  call: { name: string; arguments: string },
  signal?: AbortSignal,
): Promise<{ output: string; isError: boolean }> {
  const parsed = parseToolArguments(call.arguments);
  if (!parsed.ok) return { output: parsed.error, isError: true };
  const tool = tools.find((item) => item.name === call.name);
  if (!tool) return { output: `Unknown tool "${call.name}".`, isError: true };
  const prepared = tool.prepare ? tool.prepare(parsed.args) : { args: parsed.args };
  if ("error" in prepared) return { output: prepared.error, isError: true };
  try {
    const result = await tool.invoke(prepared.args, { signal });
    const content = result.content.trim() ? result.content : "The tool returned no content.";
    return { output: content, isError: Boolean(result.isError) };
  } catch (error) {
    if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
    const message = error instanceof Error ? error.message : "The tool failed";
    return { output: message, isError: true };
  }
}
