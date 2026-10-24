import { planMockTurn } from "./memory/mock-turn";
import { BASE_SYSTEM_PROMPT } from "./memory/prompt";
import { SseParser } from "./sse";
import type { ToolDefinition } from "./tools/types";
import type { LlmMessage, ProviderId } from "./types";

export const SYSTEM_PROMPT = BASE_SYSTEM_PROMPT;

const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";

export type ProviderEvent =
  | { type: "text"; text: string }
  | { type: "tool_call"; id: string; name?: string; argumentsDelta: string };

export type StreamToolOptions = {
  tools?: readonly ToolDefinition[];
  signal?: AbortSignal;
};

export interface LlmProvider {
  readonly id: ProviderId;
  readonly model: string | null;
  stream(messages: LlmMessage[], signal?: AbortSignal): AsyncIterable<string>;
  streamEvents?(messages: LlmMessage[], options?: StreamToolOptions): AsyncIterable<ProviderEvent>;
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
      onMessages?: (messages: LlmMessage[]) => void;
    } = {},
  ) {}

  async *stream(messages: LlmMessage[], signal?: AbortSignal): AsyncIterable<string> {
    for await (const event of this.streamEvents(messages, { signal })) {
      if (event.type === "text") yield event.text;
    }
  }

  async *streamEvents(
    messages: LlmMessage[],
    options: StreamToolOptions = {},
  ): AsyncIterable<ProviderEvent> {
    this.options.onMessages?.(messages);
    const signal = options.signal;
    if (this.options.reply) {
      yield* this.#chunkText(this.options.reply(messages), signal);
      return;
    }
    const names = new Set((options.tools ?? []).map((tool) => tool.name));
    if (names.has("memory_write")) {
      const plan = planMockTurn(messages, names);
      if (plan.type === "tool") {
        yield* this.#emitCall(plan.name, plan.args, signal);
        return;
      }
      if (plan.type === "text") {
        yield* this.#chunkText(plan.text, signal);
        return;
      }
    }
    yield* this.#chunkText(buildMockReply(lastUserText(messages)), signal);
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
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): AsyncIterable<ProviderEvent> {
    const id = `call_${crypto.randomUUID()}`;
    const raw = JSON.stringify(args);
    const size = Math.max(1, this.options.chunkSize ?? 24);
    const delay = this.options.delayMs ?? 0;
    yield { type: "tool_call", id, name, argumentsDelta: "" };
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

  async *stream(messages: LlmMessage[], signal?: AbortSignal): AsyncIterable<string> {
    for await (const event of this.streamEvents(messages, { signal })) {
      if (event.type === "text") yield event.text;
    }
  }

  async *streamEvents(
    messages: LlmMessage[],
    options: StreamToolOptions = {},
  ): AsyncIterable<ProviderEvent> {
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

function readDelta(payload: unknown): { content?: unknown; tool_calls?: unknown } | null {
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
