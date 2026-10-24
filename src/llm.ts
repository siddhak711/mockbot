import type { LlmMessage, ProviderId } from "./types";
import { SseParser } from "./sse";

export const SYSTEM_PROMPT =
  "You are Mockbot, a concise personal assistant. Reply in markdown when it helps.";

const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";

export interface LlmProvider {
  readonly id: ProviderId;
  readonly model: string | null;
  stream(messages: LlmMessage[], signal?: AbortSignal): AsyncIterable<string>;
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
    "- Press **Stop** to keep a partial answer.",
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

export class MockProvider implements LlmProvider {
  readonly id = "mock" as const;
  readonly model = null;

  constructor(
    private readonly options: {
      reply?: (messages: LlmMessage[]) => string;
      delayMs?: number;
      chunkSize?: number;
    } = {},
  ) {}

  async *stream(messages: LlmMessage[], signal?: AbortSignal): AsyncIterable<string> {
    const lastUser = [...messages].reverse().find((message) => message.role === "user");
    const text = this.options.reply?.(messages) ?? buildMockReply(lastUser?.content ?? "");
    const size = Math.max(1, this.options.chunkSize ?? 24);
    const delay = this.options.delayMs ?? 0;
    for (let index = 0; index < text.length; index += size) {
      if (signal?.aborted) return;
      if (index > 0) await sleep(delay, signal);
      if (signal?.aborted) return;
      yield text.slice(index, index + size);
    }
  }
}

function numberFrom(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
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
          messages,
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
        const content = readDelta(parsed);
        if (content) yield content;
      }
    }
  }

  #redact(text: string): string {
    return this.#apiKey ? text.split(this.#apiKey).join("[redacted]") : text;
  }
}

function readDelta(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || !choices[0] || typeof choices[0] !== "object") return "";
  const delta = (choices[0] as { delta?: unknown }).delta;
  if (!delta || typeof delta !== "object") return "";
  const content = (delta as { content?: unknown }).content;
  return typeof content === "string" ? content : "";
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
