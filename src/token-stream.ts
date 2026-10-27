import { isMockToolResult } from "./tools/display";
import type { Message, MessageTrace } from "./types";

export type TokenStreamEntry = {
  kind: "start" | "reasoning" | "tool" | "text" | "end";
  label: string;
  detail?: string;
  mock?: boolean;
};

/** Flatten a stored assistant trace into token-stream rows for the Trace pane. */
export function tokenStreamEntries(
  trace: MessageTrace | null | undefined,
  content = "",
): TokenStreamEntry[] {
  if (!trace) return [];
  const entries: TokenStreamEntry[] = [];
  if (trace.started) {
    entries.push({
      kind: "start",
      label: "start",
      detail: `role ${trace.role ?? "assistant"}`,
    });
  }
  if (trace.reasoning.length > 0) {
    entries.push({
      kind: "reasoning",
      label: "reasoning",
      detail: trace.reasoning,
    });
  }
  for (const tool of trace.tools) {
    const mock = isMockToolResult(tool.name, tool.result);
    entries.push({
      kind: "tool",
      label: tool.name || "tool",
      detail: tool.result == null ? "pending" : "done",
      ...(mock ? { mock: true } : {}),
    });
  }
  const text = content || trace.text;
  if (text.length > 0) {
    entries.push({
      kind: "text",
      label: "text",
      detail: `${text.length} characters`,
    });
  }
  if (trace.ended) {
    entries.push({
      kind: "end",
      label: "end",
      detail: `finish ${trace.finishReason ?? "stop"}`,
    });
  }
  return entries;
}

export function assistantMessagesWithTrace(messages: readonly Message[]): Message[] {
  return messages.filter((message) => message.role === "assistant" && message.trace);
}

export type RuntimeStatus = {
  provider: string;
  model: string | null;
  database: string;
};

/** Before /api/status answers the footer says "Connecting…"; if it fails, it says so. */
export type RuntimeStatusView = RuntimeStatus | "loading" | "error";

export function runtimeStatusLabel(status: RuntimeStatusView): {
  title: string;
  subtitle: string;
  full: string;
} {
  if (status === "loading") return { title: "Connecting…", subtitle: "", full: "Connecting…" };
  if (status === "error") {
    return {
      title: "Status unavailable",
      subtitle: "",
      full: "Status unavailable. The server did not answer.",
    };
  }
  const provider =
    status.provider === "openai"
      ? "OpenAI-compatible"
      : status.provider === "mock"
        ? "Mock provider"
        : status.provider;
  const database = status.database === "neon" ? "Neon" : "Local";
  const model = status.model?.trim() || null;
  const title = model ?? provider;
  const subtitle = model ? `${provider} · ${database}` : database;
  const full = model ? `${provider} · ${model} · ${database}` : `${provider} · ${database}`;
  return { title, subtitle, full };
}

/** Show the Cursor-style thinking row while a reply is live and the answer has not started. */
export function showThinkingRow(
  live: boolean,
  livePhase: string | null,
  hasAnswer: boolean,
): boolean {
  if (!live || hasAnswer) return false;
  return livePhase === null || livePhase === "start" || livePhase === "reasoning";
}
