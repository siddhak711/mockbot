import type { Sql } from "../db/sql";
import { estimateTokens } from "../memory/tokens";
import type { LlmMessage, LlmStreamEvent, ModelUsage } from "../types";
import { modelCostUsd, roundUsd } from "./cost";
import { redactSecrets } from "./redact";

export type RunEventType = "model" | "tool" | "event" | "error";

export type RunEvent = {
  runId: string;
  seq: number;
  type: RunEventType;
  input: string | null;
  output: string | null;
  tokens: number | null;
  costUsd: number | null;
  ms: number | null;
};

export type ModelCapture = {
  text: string;
  reasoning: string;
  toolCalls: Array<{ index: number; id: string; name: string; arguments: string }>;
  usage?: ModelUsage;
};

type EventRow = {
  run_id: string;
  seq: number | string;
  type: RunEventType;
  input: string | null;
  output: string | null;
  tokens: number | string | null;
  cost_usd: number | string | null;
  ms: number | string | null;
};

const MAX_FIELD = 500_000;

function asNumber(value: number | string | null): number | null {
  if (value == null) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function clip(value: string | null): string | null {
  if (value == null) return null;
  if (value.length <= MAX_FIELD) return value;
  return `${value.slice(0, MAX_FIELD)}\n[truncated]`;
}

function mapEvent(row: EventRow): RunEvent {
  return {
    runId: row.run_id,
    seq: asNumber(row.seq) ?? 0,
    type: row.type,
    input: row.input,
    output: row.output,
    tokens: asNumber(row.tokens),
    costUsd: asNumber(row.cost_usd),
    ms: asNumber(row.ms),
  };
}

function mergeName(current: string, chunk: string): string {
  if (!chunk) return current;
  if (!current || chunk === current || chunk.startsWith(current)) return chunk;
  return current + chunk;
}

export function emptyModelCapture(): ModelCapture {
  return { text: "", reasoning: "", toolCalls: [] };
}

export function captureModelEvent(state: ModelCapture, event: LlmStreamEvent): void {
  if (event.type === "text") state.text += event.text;
  if (event.type === "reasoning") state.reasoning += event.text;
  if (event.type === "end" && event.usage) state.usage = event.usage;
  if (event.type !== "tool_call") return;
  let call = state.toolCalls.find((item) => item.index === event.index);
  if (!call) {
    call = { index: event.index, id: "", name: "", arguments: "" };
    state.toolCalls.push(call);
  }
  if (event.id && !call.id) call.id = event.id;
  if (event.name) call.name = mergeName(call.name, event.name);
  if (event.arguments) call.arguments += event.arguments;
}

export function cloneMessages(messages: readonly LlmMessage[]): LlmMessage[] {
  return messages.map((message) => ({
    ...message,
    tool_calls: message.tool_calls?.map((call) => ({
      ...call,
      function: { ...call.function },
    })),
  }));
}

export function elapsedMs(started: number): number {
  return Math.max(0, Math.round(performance.now() - started));
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function normalizeArgs(input: unknown): unknown {
  if (typeof input !== "string") return input;
  const parsed = parseJsonObject(input);
  if (parsed) return parsed;
  try {
    return JSON.parse(input) as unknown;
  } catch {
    return input;
  }
}

export function runTotals(events: readonly RunEvent[]): {
  tokens: number;
  costUsd: number;
  ms: number;
} {
  let tokens = 0;
  let costUsd = 0;
  let ms = 0;
  for (const event of events) {
    if (event.type !== "model" && event.type !== "tool") continue;
    tokens += event.tokens ?? 0;
    costUsd += event.costUsd ?? 0;
    ms += event.ms ?? 0;
  }
  return { tokens, costUsd: roundUsd(costUsd), ms };
}

function oneLine(value: string, max: number): string {
  const line = value.replace(/\s+/g, " ").trim();
  if (line.length <= max) return line;
  return `${line.slice(0, max - 1)}…`;
}

export function eventSummary(event: RunEvent): string {
  if (event.type === "model") {
    const input = event.input ? parseJsonObject(event.input) : null;
    const output = event.output ? parseJsonObject(event.output) : null;
    const model = typeof input?.model === "string" && input.model ? input.model : "model";
    const text = typeof output?.text === "string" ? output.text.trim() : "";
    const calls = Array.isArray(output?.toolCalls) ? output.toolCalls : [];
    const names = calls
      .map((call) =>
        call && typeof call === "object" && typeof (call as { name?: unknown }).name === "string"
          ? (call as { name: string }).name
          : "",
      )
      .filter((name) => name.length > 0)
      .join(", ");
    const preview = text ? oneLine(text, 72) : names ? `calls ${names}` : "response";
    return `${model} · ${preview}`;
  }
  if (event.type === "tool") {
    const input = event.input ? parseJsonObject(event.input) : null;
    const name = typeof input?.name === "string" && input.name ? input.name : "tool";
    const preview = oneLine(event.output ?? "", 72);
    return preview ? `${name} · ${preview}` : name;
  }
  if (event.type === "error") return oneLine(event.output ?? "error", 96);
  const input = event.input ? parseJsonObject(event.input) : null;
  const name = typeof input?.name === "string" && input.name ? input.name : "event";
  const detail = event.output ? parseJsonObject(event.output) : null;
  const status = typeof detail?.status === "string" ? detail.status : "";
  return status ? `${name} · ${status}` : name;
}

export function formatTokenCount(value: number | null): string {
  if (value == null) return "—";
  return `${value} tok`;
}

export function formatCost(value: number | null): string {
  if (value == null) return "—";
  if (value === 0) return "$0";
  const fixed = (Math.abs(value) < 0.0001 ? value.toFixed(8) : value.toFixed(6)).replace(
    /(?:\.0+|(\.\d*?)0+)$/,
    "$1",
  );
  return `$${fixed}`;
}

export function formatDuration(value: number | null): string {
  if (value == null) return "—";
  if (value < 1000) return `${value} ms`;
  return `${(value / 1000).toFixed(1)} s`;
}

export class RunLog {
  readonly id: string;
  #seq = 0;
  #tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly db: Sql,
    id = `run_${crypto.randomUUID()}`,
  ) {
    this.id = id;
  }

  append(row: {
    type: RunEventType;
    input: string | null;
    output: string | null;
    tokens: number | null;
    costUsd: number | null;
    ms: number | null;
  }): Promise<void> {
    const task = this.#tail.then(async () => {
      this.#seq += 1;
      const seq = this.#seq;
      const input = clip(row.input == null ? null : redactSecrets(row.input));
      const output = clip(row.output == null ? null : redactSecrets(row.output));
      await this.db.query(
        `INSERT INTO run_events (run_id, seq, type, input, output, tokens, cost_usd, ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [this.id, seq, row.type, input, output, row.tokens, row.costUsd, row.ms],
      );
    });
    this.#tail = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  mark(name: string, detail?: Record<string, unknown> | null): Promise<void> {
    return this.append({
      type: "event",
      input: JSON.stringify({ name }),
      output: detail ? JSON.stringify(detail) : null,
      tokens: null,
      costUsd: null,
      ms: null,
    });
  }

  fail(message: string, detail?: Record<string, unknown>): Promise<void> {
    return this.append({
      type: "error",
      input: JSON.stringify({ name: "run.error", ...detail }),
      output: message,
      tokens: null,
      costUsd: null,
      ms: null,
    });
  }

  recordModel(options: {
    model: string | null;
    messages: readonly LlmMessage[];
    capture: ModelCapture;
    ms: number;
  }): Promise<void> {
    const output = {
      text: options.capture.text,
      reasoning: options.capture.reasoning,
      toolCalls: options.capture.toolCalls.map((call) => ({
        id: call.id,
        name: call.name,
        arguments: call.arguments,
      })),
    };
    const input = JSON.stringify({ model: options.model, messages: options.messages });
    const outputText = JSON.stringify(output);
    const usage = options.capture.usage ?? {
      inputTokens: estimateTokens(input),
      outputTokens: estimateTokens(outputText),
    };
    return this.append({
      type: "model",
      input,
      output: outputText,
      tokens: usage.inputTokens + usage.outputTokens,
      costUsd: modelCostUsd(options.model, usage.inputTokens, usage.outputTokens),
      ms: Math.max(0, Math.round(options.ms)),
    });
  }

  recordTool(options: { name: string; input: unknown; output: string; ms: number }): Promise<void> {
    const input = JSON.stringify({ name: options.name, arguments: normalizeArgs(options.input) });
    const output = options.output;
    return this.append({
      type: "tool",
      input,
      output,
      tokens: estimateTokens(input) + estimateTokens(output),
      costUsd: 0,
      ms: Math.max(0, Math.round(options.ms)),
    });
  }
}

export async function listRunEvents(db: Sql, runId: string): Promise<RunEvent[]> {
  const result = await db.query<EventRow>(
    `SELECT run_id, seq, type, input, output, tokens, cost_usd, ms
     FROM run_events
     WHERE run_id = $1
     ORDER BY seq ASC`,
    [runId],
  );
  return result.rows.map(mapEvent);
}
