import type { LlmMessage, ProviderId } from "./types";
import { SseParser } from "./sse";
import type { ToolDefinition } from "./tools/types";

export const SYSTEM_PROMPT = [
  "You are Mockbot, a concise personal assistant. Reply in markdown when it helps.",
  "",
  "You can call tools. Prefer a tool when it can answer the question. At most 15 tools are listed at once. If you need something that is not listed, call tool_search with a short query, then call the tool it returns.",
  "",
  "Read-only tools run immediately. Tools that send, post, delete, pay, or invite someone wait until the person approves them. If they deny a tool, do not retry it unless they ask again.",
].join("\n");

const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";

export type ProviderEvent =
  | { type: "text"; text: string }
  | { type: "tool_call"; id: string; name?: string; argumentsDelta: string };

export type StreamOptions = {
  tools?: readonly ToolDefinition[];
  signal?: AbortSignal;
};

export interface LlmProvider {
  readonly id: ProviderId;
  readonly model: string | null;
  stream(messages: LlmMessage[], options?: StreamOptions): AsyncIterable<ProviderEvent>;
}

export function buildMockReply(userText: string): string {
  const quoted = userText.replace(/\s+/g, " ").trim();
  return [
    "This is a **mock reply**. No API key was sent anywhere.",
    "",
    "You said:",
    "",
    `> ${quoted}`,
    "",
    "### Still here after a refresh",
    "",
    "- The conversation list and this transcript are stored locally.",
    "- Use the Stop generating button to keep a partial answer.",
    "- Set `LLM_PROVIDER=openai` when you want a live model.",
    "",
    "```text",
    "provider=mock",
    "```",
    "",
    "The rest of this reply is padding so the stream stays open long enough to stop.",
    "",
    "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.",
  ].join("\n");
}

const WRITE_DEMO = /\b(schedule|invite|send|post|delete|pay)\b/i;

function demoPlan(userText: string): Array<{ name: string; args: Record<string, unknown> }> {
  const text = userText.toLowerCase();
  const query = userText.replace(/\s+/g, " ").trim().slice(0, 160) || "mockbot";
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [
    { name: "tool_search", args: { query: demoSearchQuery(text) } },
  ];
  if (WRITE_DEMO.test(text)) {
    calls.push({
      name: "google_calendar",
      args: {
        action: "create",
        summary: "Planning meeting",
        start: "2026-10-25T15:00:00Z",
        end: "2026-10-25T15:30:00Z",
        attendees: ["team@example.com"],
        description: "Scheduled from the mock provider.",
      },
    });
    return calls;
  }
  if (/\b(calendar|agenda)\b/.test(text)) {
    calls.push({ name: "google_calendar", args: { action: "list" } });
    return calls;
  }
  if (/\b(github|issue|pull request|\bprs?\b)\b/.test(text)) {
    calls.push({
      name: "github",
      args: { action: "list_issues", owner: "mockbot", repo: "mockbot" },
    });
    return calls;
  }
  const url = userText.match(/https?:\/\/\S+/)?.[0]?.replace(/[),.]+$/, "");
  if (url && /\b(fetch|open|read|page)\b/i.test(userText)) {
    calls.push({ name: "web_fetch", args: { url } });
    return calls;
  }
  calls.push({ name: "web_search", args: { query } });
  return calls;
}

function demoSearchQuery(text: string): string {
  if (WRITE_DEMO.test(text) || /\b(calendar|agenda)\b/.test(text)) return "calendar";
  if (/\b(github|issue|pull request|\bprs?\b)\b/.test(text)) return "github";
  if (/\b(fetch|url|page|http)\b/.test(text)) return "fetch web page";
  return "web search";
}

function toolResultsThisTurn(messages: LlmMessage[]): number {
  let count = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role === "user") break;
    if (message.role === "tool") count += 1;
  }
  return count;
}

function demoClosing(userText: string, messages: LlmMessage[]): string {
  if (WRITE_DEMO.test(userText)) {
    const denied = messages.some(
      (message) =>
        message.role === "tool" &&
        (message.content.includes("The user denied this action") ||
          message.content.includes("Approval timed out")),
    );
    if (denied) {
      return "I looked up the calendar tool and drafted an invite for **team@example.com**. You denied it, so the event was not created.";
    }
    return [
      "I looked up the calendar tool and created a **planning meeting**.",
      "",
      "- When: 25 Oct 2026, 15:00–15:30 UTC",
      "- Invite: team@example.com",
      "",
      "This came from the mock provider, so no API key was used.",
    ].join("\n");
  }
  const second = demoPlan(userText)[1];
  if (second?.name === "github") {
    return "I searched the tool catalog and read the mock GitHub issues. The newest open issue is **Show tool calls in the transcript**.";
  }
  if (second?.name === "google_calendar") {
    return "I searched the tool catalog and checked the calendar. The next mock event is **Mockbot planning** on 25 Oct 2026 at 15:00 UTC.";
  }
  if (second?.name === "web_fetch") {
    return "I searched the tool catalog and fetched the page. The mock provider did not call the network.";
  }
  return buildMockReply(userText);
}

function abortError(): Error {
  return Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw abortError();
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function lastUserText(messages: LlmMessage[]): string {
  const lastUser = [...messages].reverse().find((message) => message.role === "user");
  return lastUser?.content ?? "";
}

export class MockProvider implements LlmProvider {
  readonly id = "mock" as const;
  readonly model = null;

  constructor(
    private readonly options: {
      reply?: (messages: LlmMessage[]) => string;
      delayMs?: number;
      chunkSize?: number;
      demoTools?: boolean;
    } = {},
  ) {}

  async *stream(messages: LlmMessage[], options: StreamOptions = {}): AsyncIterable<ProviderEvent> {
    const signal = options.signal;
    if (this.options.reply) {
      yield* this.#chunkText(this.options.reply(messages), signal);
      return;
    }
    if (!this.options.demoTools) {
      yield* this.#chunkText(buildMockReply(lastUserText(messages)), signal);
      return;
    }
    const userText = lastUserText(messages);
    const plan = demoPlan(userText);
    const completed = toolResultsThisTurn(messages);
    const next = plan[completed];
    if (next) {
      yield* this.#emitCall(next, signal);
      return;
    }
    yield* this.#chunkText(demoClosing(userText, messages), signal);
  }

  async *#chunkText(text: string, signal?: AbortSignal): AsyncIterable<ProviderEvent> {
    const size = Math.max(1, this.options.chunkSize ?? 24);
    const delay = this.options.delayMs ?? 0;
    for (let index = 0; index < text.length; index += size) {
      if (signal?.aborted) return;
      if (index > 0) await sleep(delay, signal);
      if (signal?.aborted) return;
      yield { type: "text", text: text.slice(index, index + size) };
    }
  }

  async *#emitCall(
    call: { name: string; args: Record<string, unknown> },
    signal?: AbortSignal,
  ): AsyncIterable<ProviderEvent> {
    const id = `call_${crypto.randomUUID()}`;
    const raw = JSON.stringify(call.args);
    const size = Math.max(1, this.options.chunkSize ?? 24);
    const delay = this.options.delayMs ?? 0;
    yield { type: "tool_call", id, name: call.name, argumentsDelta: "" };
    for (let index = 0; index < raw.length; index += size) {
      if (index > 0) await sleep(delay, signal);
      if (signal?.aborted) return;
      yield { type: "tool_call", id, argumentsDelta: raw.slice(index, index + size) };
    }
  }
}

function numberFrom(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

type ToolAccumulator = {
  id: string;
  name: string;
  arguments: string;
  emitted: number;
  announced: boolean;
};

export class ToolCallAssembler {
  #calls = new Map<number, ToolAccumulator>();

  push(part: {
    index?: number;
    id?: string;
    function?: { name?: string; arguments?: string };
  }): ProviderEvent[] {
    const index = typeof part.index === "number" ? part.index : 0;
    let acc = this.#calls.get(index);
    if (!acc) {
      const id =
        typeof part.id === "string" && part.id ? part.id : `call_${index}_${crypto.randomUUID()}`;
      acc = { id, name: "", arguments: "", emitted: 0, announced: false };
      this.#calls.set(index, acc);
    }
    if (!acc.announced && typeof part.id === "string" && part.id) acc.id = part.id;
    if (typeof part.function?.name === "string" && part.function.name)
      acc.name = part.function.name;
    if (typeof part.function?.arguments === "string") acc.arguments += part.function.arguments;
    if (!acc.announced && acc.name) {
      acc.announced = true;
      acc.emitted = acc.arguments.length;
      return [{ type: "tool_call", id: acc.id, name: acc.name, argumentsDelta: acc.arguments }];
    }
    if (acc.announced && acc.arguments.length > acc.emitted) {
      const delta = acc.arguments.slice(acc.emitted);
      acc.emitted = acc.arguments.length;
      return [{ type: "tool_call", id: acc.id, argumentsDelta: delta }];
    }
    return [];
  }
}

function wireMessage(message: LlmMessage): Record<string, unknown> {
  if (message.role === "assistant" && message.tool_calls?.length) {
    return {
      role: "assistant",
      content: message.content ? message.content : null,
      tool_calls: message.tool_calls,
    };
  }
  if (message.role === "tool") {
    return {
      role: "tool",
      tool_call_id: message.tool_call_id,
      content: message.content,
    };
  }
  return { role: message.role, content: message.content };
}

function wireTools(tools: readonly ToolDefinition[]): Array<Record<string, unknown>> {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }));
}

export class OpenAiCompatibleProvider implements LlmProvider {
  readonly id = "openai" as const;
  readonly model: string;
  readonly #apiKey: string;
  readonly #baseUrl: string;

  constructor(options: { apiKey: string; baseUrl: string; model: string }) {
    this.#apiKey = options.apiKey;
    this.#baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.model = options.model;
  }

  async *stream(messages: LlmMessage[], options: StreamOptions = {}): AsyncIterable<ProviderEvent> {
    const signal = options.signal;
    const tools = options.tools ?? [];
    let response: Response;
    try {
      response = await fetch(`${this.#baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.#apiKey}`,
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify({
          model: this.model,
          stream: true,
          messages: messages.map(wireMessage),
          ...(tools.length > 0 ? { tools: wireTools(tools), tool_choice: "auto" } : {}),
        }),
        signal,
      });
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
        throw Object.assign(abortError(), { cause: error });
      }
      throw new Error(
        this.#redact(error instanceof Error ? error.message : "The model request failed"),
        { cause: error },
      );
    }

    if (!response.ok) {
      const body = this.#redact(await response.text());
      throw new Error(`LLM request failed (${response.status}): ${body.slice(0, 500)}`);
    }
    if (!response.body) throw new Error("LLM request returned an empty body");

    const parser = new SseParser();
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const assembler = new ToolCallAssembler();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const message of parser.push(decoder.decode(value, { stream: true }))) {
        const payload = message.data.trim();
        if (payload === "[DONE]") return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(payload);
        } catch {
          continue;
        }
        const failure = readError(parsed);
        if (failure) throw new Error(this.#redact(failure));
        const content = readContent(parsed);
        if (content) yield { type: "text", text: content };
        for (const part of readToolCallParts(parsed)) {
          for (const event of assembler.push(part)) yield event;
        }
      }
    }
  }

  #redact(text: string): string {
    return this.#apiKey ? text.split(this.#apiKey).join("[redacted]") : text;
  }
}

function readError(payload: unknown): string {
  if (!payload || typeof payload !== "object" || !("error" in payload)) return "";
  const error = (payload as { error?: unknown }).error;
  if (typeof error === "string") return error;
  if (
    error &&
    typeof error === "object" &&
    typeof (error as { message?: unknown }).message === "string"
  ) {
    return (error as { message: string }).message;
  }
  return "The model request failed";
}

function readContent(payload: unknown): string {
  const delta = readDelta(payload);
  const content = delta?.content;
  return typeof content === "string" ? content : "";
}

function readToolCallParts(payload: unknown): Array<{
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}> {
  const delta = readDelta(payload);
  const toolCalls = delta?.tool_calls;
  if (!Array.isArray(toolCalls)) return [];
  return toolCalls.filter((part) => part && typeof part === "object") as Array<{
    index?: number;
    id?: string;
    function?: { name?: string; arguments?: string };
  }>;
}

function readDelta(payload: unknown): {
  content?: unknown;
  tool_calls?: unknown;
} | null {
  if (!payload || typeof payload !== "object") return null;
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || !choices[0] || typeof choices[0] !== "object") return null;
  const delta = (choices[0] as { delta?: unknown }).delta;
  if (!delta || typeof delta !== "object") return null;
  return delta as { content?: unknown; tool_calls?: unknown };
}

export function selectProvider(env: Record<string, string | undefined> = process.env): LlmProvider {
  const name = (env.LLM_PROVIDER ?? "mock").trim().toLowerCase() || "mock";
  if (name === "mock") {
    return new MockProvider({
      delayMs: numberFrom(env.MOCK_STREAM_DELAY_MS, 60),
      chunkSize: numberFrom(env.MOCK_CHUNK_SIZE, 8),
      demoTools: true,
    });
  }
  if (name === "openai") {
    const apiKey = env.LLM_API_KEY?.trim() ?? "";
    if (!apiKey) {
      throw new Error("LLM_API_KEY is required when LLM_PROVIDER=openai");
    }
    return new OpenAiCompatibleProvider({
      apiKey,
      baseUrl: env.LLM_BASE_URL?.trim() || DEFAULT_OPENAI_BASE_URL,
      model: env.LLM_MODEL?.trim() || DEFAULT_OPENAI_MODEL,
    });
  }
  throw new Error(`Unknown LLM_PROVIDER "${name}". Expected "mock" or "openai".`);
}
