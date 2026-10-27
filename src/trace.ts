import type {
  LivePhase,
  LlmMessage,
  LlmStreamEvent,
  Message,
  MessageTrace,
  ToolTrace,
  TraceSegment,
} from "./types";

export function emptyTrace(): MessageTrace {
  return {
    started: false,
    role: null,
    reasoning: "",
    tools: [],
    text: "",
    finishReason: null,
    ended: false,
    system: "",
    prefill: "",
    segments: [],
  };
}

/** System text and a trailing assistant prefill from the messages sent to the model. */
export function modelPromptParts(messages: readonly LlmMessage[]): {
  system: string;
  prefill: string;
} {
  const system = messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n");
  const last = messages[messages.length - 1];
  const prefill = last?.role === "assistant" && !last.tool_calls?.length ? last.content : "";
  return { system, prefill };
}

export function hasVisibleStream(trace: MessageTrace, text: string): boolean {
  return (
    text.length > 0 ||
    trace.started ||
    trace.reasoning.length > 0 ||
    trace.tools.length > 0 ||
    trace.ended
  );
}

function copyTools(tools: ToolTrace[]): ToolTrace[] {
  return tools.map((tool) => ({ ...tool }));
}

function appendSegments(trace: MessageTrace, segment: TraceSegment): TraceSegment[] {
  const segments = [...(trace.segments ?? [])];
  if (segment.type === "tool") {
    if (segments.some((item) => item.type === "tool" && item.index === segment.index)) {
      return segments;
    }
    segments.push(segment);
    return segments;
  }
  if (!segment.text) return segments;
  const last = segments[segments.length - 1];
  if (last && last.type === segment.type) {
    segments[segments.length - 1] = { type: segment.type, text: last.text + segment.text };
    return segments;
  }
  segments.push({ type: segment.type, text: segment.text });
  return segments;
}

function mergeName(current: string, chunk: string): string {
  if (!chunk) return current;
  if (!current || chunk === current) return chunk;
  if (chunk.startsWith(current)) return chunk;
  return current + chunk;
}

export function applyStreamEvent(trace: MessageTrace, event: LlmStreamEvent): MessageTrace {
  switch (event.type) {
    case "start":
      return { ...trace, started: true, role: "assistant" };
    case "reasoning":
      return {
        ...trace,
        reasoning: trace.reasoning + event.text,
        segments: appendSegments(trace, { type: "reasoning", text: event.text }),
      };
    case "text":
      return {
        ...trace,
        text: trace.text + event.text,
        segments: appendSegments(trace, { type: "text", text: event.text }),
      };
    case "end":
      return { ...trace, ended: true, finishReason: event.finishReason };
    case "tool_call": {
      const tools = copyTools(trace.tools);
      let tool = tools.find((item) => item.index === event.index);
      if (!tool) {
        tool = { index: event.index, id: "", name: "", arguments: "", result: null };
        tools.push(tool);
        tools.sort((left, right) => left.index - right.index);
      }
      if (event.id && !tool.id) tool.id = event.id;
      if (event.name) tool.name = mergeName(tool.name, event.name);
      if (event.arguments) tool.arguments += event.arguments;
      return {
        ...trace,
        tools,
        segments: appendSegments(trace, { type: "tool", index: tool.index }),
      };
    }
    case "tool_result": {
      const tools = copyTools(trace.tools);
      let tool = event.id ? tools.find((item) => item.id === event.id) : undefined;
      if (!tool) {
        tool = tools.find((item) => item.name === event.name && item.result == null);
      }
      if (!tool) {
        tool = {
          index: tools.length,
          id: event.id,
          name: event.name,
          arguments: "",
          result: null,
        };
        tools.push(tool);
      }
      tool.result = event.content;
      if (event.id) tool.id = event.id;
      if (event.name) tool.name = mergeName(tool.name, event.name);
      return {
        ...trace,
        tools,
        segments: appendSegments(trace, { type: "tool", index: tool.index }),
      };
    }
    default:
      return trace;
  }
}

function traceOf(message: Message): MessageTrace {
  if (message.trace) return message.trace;
  return { ...emptyTrace(), text: message.content };
}

export function applyClientEvent(
  message: Message,
  event: string,
  data: Record<string, unknown>,
): Message {
  const trace = traceOf(message);
  if (event === "start") {
    return { ...message, trace: applyStreamEvent(trace, { type: "start", role: "assistant" }) };
  }
  if (event === "reasoning") {
    const text = typeof data.text === "string" ? data.text : "";
    return { ...message, trace: applyStreamEvent(trace, { type: "reasoning", text }) };
  }
  if (event === "tool_call") {
    const next = applyStreamEvent(trace, {
      type: "tool_call",
      index: typeof data.index === "number" ? data.index : 0,
      ...(typeof data.id === "string" && data.id ? { id: data.id } : {}),
      ...(typeof data.name === "string" && data.name ? { name: data.name } : {}),
      ...(typeof data.arguments === "string" && data.arguments
        ? { arguments: data.arguments }
        : {}),
    });
    return { ...message, trace: next };
  }
  if (event === "tool_result") {
    const next = applyStreamEvent(trace, {
      type: "tool_result",
      id: typeof data.id === "string" ? data.id : "",
      name: typeof data.name === "string" ? data.name : "",
      content: typeof data.content === "string" ? data.content : "",
    });
    return { ...message, trace: next };
  }
  if (event === "delta") {
    const text = typeof data.text === "string" ? data.text : "";
    const next = applyStreamEvent(trace, { type: "text", text });
    return { ...message, content: next.text, trace: next };
  }
  if (event === "end") {
    const finishReason = typeof data.finishReason === "string" ? data.finishReason : null;
    return { ...message, trace: applyStreamEvent(trace, { type: "end", finishReason }) };
  }
  if (event === "prompt") {
    const system = typeof data.system === "string" ? data.system : (trace.system ?? "");
    const prefill = typeof data.prefill === "string" ? data.prefill : (trace.prefill ?? "");
    return { ...message, trace: { ...trace, system, prefill } };
  }
  return message;
}

export function phaseFromEvent(event: string): LivePhase | null {
  if (event === "start") return "start";
  if (event === "reasoning") return "reasoning";
  if (event === "tool_call" || event === "tool_result") return "tool";
  if (event === "delta") return "text";
  if (event === "end") return "end";
  return null;
}

export function streamedWeight(message: Message | undefined): number {
  if (!message) return 0;
  const trace = message.trace;
  const text = Math.max(message.content.length, trace?.text.length ?? 0);
  if (!trace) return text;
  const tools = trace.tools.reduce(
    (sum, tool) => sum + tool.name.length + tool.arguments.length + (tool.result?.length ?? 0),
    0,
  );
  return (
    text +
    trace.reasoning.length +
    tools +
    (trace.system?.length ?? 0) +
    (trace.prefill?.length ?? 0) +
    (trace.started ? 1 : 0) +
    (trace.ended ? 1 : 0)
  );
}

function parseTool(value: unknown, index: number): ToolTrace | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<ToolTrace>;
  return {
    index: typeof raw.index === "number" ? raw.index : index,
    id: typeof raw.id === "string" ? raw.id : "",
    name: typeof raw.name === "string" ? raw.name : "",
    arguments: typeof raw.arguments === "string" ? raw.arguments : "",
    result: typeof raw.result === "string" ? raw.result : null,
  };
}

function parseSegments(value: unknown): TraceSegment[] {
  if (!Array.isArray(value)) return [];
  const segments: TraceSegment[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const raw = item as { type?: unknown; text?: unknown; index?: unknown };
    if ((raw.type === "reasoning" || raw.type === "text") && typeof raw.text === "string") {
      segments.push({ type: raw.type, text: raw.text });
      continue;
    }
    if (raw.type === "tool" && typeof raw.index === "number") {
      segments.push({ type: "tool", index: raw.index });
    }
  }
  return segments;
}

export function parseTrace(value: unknown): MessageTrace | null {
  if (value == null) return null;
  let record: unknown = value;
  if (typeof value === "string") {
    try {
      record = JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }
  if (!record || typeof record !== "object") return null;
  const raw = record as Partial<MessageTrace>;
  const tools = Array.isArray(raw.tools)
    ? raw.tools.flatMap((tool, index) => {
        const parsed = parseTool(tool, index);
        return parsed ? [parsed] : [];
      })
    : [];
  const route = parseRoute(raw.route);
  return {
    started: Boolean(raw.started),
    role: raw.role === "assistant" ? "assistant" : null,
    reasoning: typeof raw.reasoning === "string" ? raw.reasoning : "",
    tools,
    text: typeof raw.text === "string" ? raw.text : "",
    finishReason: typeof raw.finishReason === "string" ? raw.finishReason : null,
    ended: Boolean(raw.ended),
    system: typeof raw.system === "string" ? raw.system : "",
    prefill: typeof raw.prefill === "string" ? raw.prefill : "",
    segments: parseSegments(raw.segments),
    ...(route ? { route } : {}),
  };
}

function parseRoute(value: unknown): MessageTrace["route"] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as { tier?: unknown; reason?: unknown; model?: unknown };
  if (raw.tier !== "cheap" && raw.tier !== "strong") return undefined;
  const reasons = ["chat", "tool", "plan", "code", "retry"] as const;
  if (!reasons.includes(raw.reason as (typeof reasons)[number])) return undefined;
  if (typeof raw.model !== "string" || raw.model.length === 0) return undefined;
  return {
    tier: raw.tier,
    reason: raw.reason as (typeof reasons)[number],
    model: raw.model,
  };
}
