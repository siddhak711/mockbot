import { planMockTurn } from "./memory/mock-turn";
import { SYSTEM_PROMPT } from "./memory/prompt";
import type { LlmMessage, LlmStreamEvent, ProviderId } from "./types";

export { SYSTEM_PROMPT };
import { readOpenAiEvents } from "./openai-events";
import { SseParser } from "./sse";
import type { ToolDefinition } from "./tools/types";

const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";

export const MOCK_TOOL_ID = "call_lookup";
export const MOCK_TOOL_NAME = "lookup_context";
export const MOCK_TOOL_RESULT =
  "Local context only. No API key is configured, so this reply stays on the mock provider.";

export type StreamOptions = {
  tools?: readonly ToolDefinition[];
  signal?: AbortSignal;
  /** Overrides the provider model for this request. The router sets it per turn. */
  model?: string;
  conversationId?: string;
  /** The previous attempt on this turn failed. The router escalates when this is set. */
  retryAfterFailure?: boolean;
};

export interface LlmProvider {
  readonly id: ProviderId;
  readonly model: string | null;
  stream(
    messages: LlmMessage[],
    options?: StreamOptions | AbortSignal,
  ): AsyncIterable<LlmStreamEvent>;
}

export function streamOptions(input?: StreamOptions | AbortSignal): StreamOptions {
  if (!input) return {};
  if (input instanceof AbortSignal) {
    const extra = input as AbortSignal & {
      tools?: readonly ToolDefinition[];
      model?: string;
      conversationId?: string;
      retryAfterFailure?: boolean;
    };
    return {
      signal: input,
      ...(extra.tools ? { tools: extra.tools } : {}),
      ...(extra.model ? { model: extra.model } : {}),
      ...(extra.conversationId ? { conversationId: extra.conversationId } : {}),
      ...(extra.retryAfterFailure ? { retryAfterFailure: true } : {}),
    };
  }
  return input;
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

export function buildMockReasoning(userText: string): string {
  const quoted = userText.replace(/\s+/g, " ").trim();
  return `The request is “${quoted}”. I should check local context before answering, and I should not send an API key.`;
}

export function buildMockToolArguments(userText: string): string {
  return JSON.stringify({ query: userText.replace(/\s+/g, " ").trim() });
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

function chunkText(text: string, size: number): string[] {
  const width = Math.max(1, size);
  const parts: string[] = [];
  for (let index = 0; index < text.length; index += width) {
    parts.push(text.slice(index, index + width));
  }
  return parts;
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

const NAMED_CALL = /^Call\s+([A-Za-z_][A-Za-z0-9_-]*)\s+(\{[\s\S]*\})\s*$/;

function namedToolRequest(
  userText: string,
  tools: readonly ToolDefinition[],
): { name: string; args: Record<string, unknown>; found: boolean } | null {
  const match = NAMED_CALL.exec(userText.trim());
  const requested = match?.[1];
  const rawArgs = match?.[2];
  if (!requested || !rawArgs) return null;
  let args: Record<string, unknown>;
  try {
    const value = JSON.parse(rawArgs) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    args = value as Record<string, unknown>;
  } catch {
    return null;
  }
  const tool = tools.find((item) => item.name === requested);
  return { name: tool?.name ?? requested, args, found: Boolean(tool) };
}

export class MockProvider implements LlmProvider {
  readonly id = "mock" as const;
  readonly model = null;

  constructor(
    private readonly options: {
      reply?: (messages: LlmMessage[]) => string | undefined;
      delayMs?: number;
      chunkSize?: number;
      /**
       * Test-only. Return tool calls to emit, or null to use the normal mock stream.
       * The live mock leaves this unset and does not invent a tool call.
       */
      tools?: (
        messages: LlmMessage[],
      ) => Array<{ id?: string; name: string; arguments: string }> | null;
      /** Test-only. The live mock provider leaves this unset and does not invent a tool call. */
      scriptToolCall?: boolean;
      /** Test-only. Runs the scripted registry demo. The live mock leaves this unset. */
      demoTools?: boolean;
      onMessages?: (messages: LlmMessage[]) => void;
    } = {},
  ) {}

  async *stream(
    messages: LlmMessage[],
    input?: StreamOptions | AbortSignal,
  ): AsyncIterable<LlmStreamEvent> {
    this.options.onMessages?.(messages);
    const { signal, tools = [] } = streamOptions(input);
    const userText = lastUserText(messages);
    if (this.options.demoTools && !this.options.reply && !this.options.tools) {
      const next = demoPlan(userText)[toolResultsThisTurn(messages)];
      if (next) {
        yield* this.#emitCall(next, signal);
        return;
      }
      yield* this.#chunkText(demoClosing(userText, messages), signal);
      return;
    }

    if (!this.options.reply && !this.options.scriptToolCall && !this.options.tools) {
      const requested = namedToolRequest(userText, tools);
      if (requested && toolResultsThisTurn(messages) === 0) {
        if (!requested.found) {
          yield* this.#chunkText(
            `I can't call ${requested.name}. It is not in this turn's tool list.`,
            signal,
          );
          return;
        }
        yield* this.#emitCall({ name: requested.name, args: requested.args }, signal);
        return;
      }
      if (requested && requested.found) {
        const result =
          [...messages].reverse().find((message) => message.role === "tool")?.content ?? "";
        yield* this.#chunkText(`I called ${requested.name}.\n\n${result}`, signal);
        return;
      }
    }

    const scriptedTools = this.options.tools?.(messages) ?? null;
    const customReply = this.options.reply?.(messages);
    if (
      scriptedTools == null &&
      !this.options.reply &&
      tools.some((tool) => tool.name === "memory_write")
    ) {
      const plan = planMockTurn(messages, new Set(tools.map((tool) => tool.name)));
      if (plan.type === "tool") {
        yield* this.#emitCall({ name: plan.name, args: plan.args }, signal);
        return;
      }
      if (plan.type === "text") {
        yield* this.#chunkText(plan.text, signal);
        return;
      }
    }

    const text = customReply ?? buildMockReply(userText);
    const size = Math.max(1, this.options.chunkSize ?? 24);
    const delay = this.options.delayMs ?? 0;

    if (signal?.aborted) return;
    yield { type: "start", role: "assistant" };

    if (scriptedTools) {
      for (let index = 0; index < scriptedTools.length; index += 1) {
        const tool = scriptedTools[index];
        if (!tool) continue;
        await sleep(delay, signal);
        if (signal?.aborted) return;
        yield {
          type: "tool_call",
          index,
          id: tool.id ?? `call_${index}`,
          name: tool.name,
          arguments: tool.arguments,
        };
      }
      if (customReply !== undefined) {
        let started = false;
        for (const piece of chunkText(customReply, size)) {
          if (started) await sleep(delay, signal);
          started = true;
          if (signal?.aborted) return;
          yield { type: "text", text: piece };
        }
        if (signal?.aborted) return;
        await sleep(delay, signal);
        if (signal?.aborted) return;
        yield { type: "end", finishReason: "stop" };
        return;
      }
      if (signal?.aborted) return;
      yield { type: "end", finishReason: "tool_calls" };
      return;
    }

    if (!this.options.reply) {
      for (const piece of chunkText(buildMockReasoning(userText), size)) {
        await sleep(delay, signal);
        if (signal?.aborted) return;
        yield { type: "reasoning", text: piece };
      }
    }

    if (this.options.scriptToolCall) {
      await sleep(delay, signal);
      if (signal?.aborted) return;
      yield { type: "tool_call", index: 0, id: MOCK_TOOL_ID, name: MOCK_TOOL_NAME };
      for (const piece of chunkText(buildMockToolArguments(userText), size)) {
        await sleep(delay, signal);
        if (signal?.aborted) return;
        yield { type: "tool_call", index: 0, arguments: piece };
      }
      await sleep(delay, signal);
      if (signal?.aborted) return;
      yield {
        type: "tool_result",
        id: MOCK_TOOL_ID,
        name: MOCK_TOOL_NAME,
        content: MOCK_TOOL_RESULT,
      };
    }

    let started = false;
    for (const piece of chunkText(text, size)) {
      if (started) await sleep(delay, signal);
      started = true;
      if (signal?.aborted) return;
      yield { type: "text", text: piece };
    }
    if (signal?.aborted) return;
    await sleep(delay, signal);
    if (signal?.aborted) return;
    yield { type: "end", finishReason: "stop" };
  }

  async *#chunkText(text: string, signal?: AbortSignal): AsyncIterable<LlmStreamEvent> {
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
  ): AsyncIterable<LlmStreamEvent> {
    const id = `call_${crypto.randomUUID()}`;
    const raw = JSON.stringify(call.args);
    const size = Math.max(1, this.options.chunkSize ?? 24);
    const delay = this.options.delayMs ?? 0;
    if (signal?.aborted) return;
    yield { type: "tool_call", index: 0, id, name: call.name };
    for (const piece of chunkText(raw, size)) {
      await sleep(delay, signal);
      if (signal?.aborted) return;
      yield { type: "tool_call", index: 0, arguments: piece };
    }
    if (signal?.aborted) return;
    yield { type: "end", finishReason: "tool_calls" };
  }
}

type AssembledToolCall = {
  type: "tool_call";
  id: string;
  name?: string;
  argumentsDelta: string;
};

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
  }): AssembledToolCall[] {
    const index = typeof part.index === "number" ? part.index : 0;
    let acc = this.#calls.get(index);
    if (!acc) {
      const id =
        typeof part.id === "string" && part.id ? part.id : `call_${index}_${crypto.randomUUID()}`;
      acc = { id, name: "", arguments: "", emitted: 0, announced: false };
      this.#calls.set(index, acc);
    }
    if (!acc.announced && typeof part.id === "string" && part.id) acc.id = part.id;
    if (typeof part.function?.name === "string" && part.function.name) {
      acc.name = part.function.name;
    }
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

function numberFrom(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
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

  async *stream(
    messages: LlmMessage[],
    input?: StreamOptions | AbortSignal,
  ): AsyncIterable<LlmStreamEvent> {
    const { signal, tools = [], model } = streamOptions(input);
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
          model: model || this.model,
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
    let ended = false;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const message of parser.push(decoder.decode(value, { stream: true }))) {
        const payload = message.data.trim();
        if (payload === "[DONE]") {
          if (!ended) yield { type: "end", finishReason: "stop" };
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(payload);
        } catch {
          continue;
        }
        const failure = readError(parsed);
        if (failure) throw new Error(this.#redact(failure));
        for (const event of readOpenAiEvents(parsed)) {
          if (event.type === "end") ended = true;
          yield event;
        }
      }
    }
    if (!ended) yield { type: "end", finishReason: "stop" };
  }

  #redact(text: string): string {
    return this.#apiKey ? text.split(this.#apiKey).join("[redacted]") : text;
  }
}

function httpBaseUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return trimmed.replace(/\/+$/, "");
  } catch {
    return undefined;
  }
}

export function selectProvider(env: Record<string, string | undefined> = process.env): LlmProvider {
  const name = (env.LLM_PROVIDER ?? "mock").trim().toLowerCase() || "mock";
  const mock = () =>
    new MockProvider({
      delayMs: numberFrom(env.MOCK_STREAM_DELAY_MS, 60),
      chunkSize: numberFrom(env.MOCK_CHUNK_SIZE, 8),
    });
  if (name === "mock") return mock();
  const apiKey = env.LLM_API_KEY?.trim() ?? "";
  if (!apiKey) {
    throw new Error(
      name === "openai"
        ? "LLM_API_KEY is required when LLM_PROVIDER=openai"
        : `Unknown LLM_PROVIDER "${name}". Expected "mock" or "openai".`,
    );
  }
  const configured = env.LLM_BASE_URL?.trim();
  const baseUrl = httpBaseUrl(configured);
  if (configured && !baseUrl) {
    console.warn(
      "LLM is using a mock implementation because LLM_BASE_URL is not a valid http(s) URL.",
    );
    return mock();
  }
  return new OpenAiCompatibleProvider({
    apiKey,
    baseUrl: baseUrl || DEFAULT_OPENAI_BASE_URL,
    model: env.LLM_MODEL?.trim() || DEFAULT_OPENAI_MODEL,
  });
}
