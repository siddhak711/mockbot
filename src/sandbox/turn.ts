import { parseDelegatePhrase } from "../agents/mock-script";
import { streamOptions, type LlmProvider, type StreamOptions } from "../llm";
import type { LlmMessage, LlmStreamEvent, ProviderId } from "../types";
import { planComputerTurn, type ComputerAction } from "./plan";

export class SandboxTurnProvider implements LlmProvider {
  readonly #inner: LlmProvider;
  readonly #delayMs: number;

  constructor(options: { inner: LlmProvider; delayMs?: number }) {
    this.#inner = options.inner;
    this.#delayMs = options.delayMs ?? 0;
  }

  get id(): ProviderId {
    return this.#inner.id;
  }

  get model(): string | null {
    return this.#inner.model;
  }

  /** Decision from the wrapped router, when this turn actually called it. */
  get lastDecision(): {
    tier: "cheap" | "strong";
    reason: "chat" | "tool" | "plan" | "code" | "retry";
    model: string;
  } | null {
    const inner = this.#inner as LlmProvider & {
      lastDecision?: {
        tier: "cheap" | "strong";
        reason: "chat" | "tool" | "plan" | "code" | "retry";
        model: string;
      } | null;
    };
    return inner.lastDecision ?? null;
  }

  async *stream(
    messages: LlmMessage[],
    input?: StreamOptions | AbortSignal,
  ): AsyncIterable<LlmStreamEvent> {
    const { signal } = streamOptions(input);
    const lastUser = [...messages].reverse().find((message) => message.role === "user");
    const text = lastUser?.content ?? "";
    const plan =
      this.#inner.id === "mock" && ownsComputerTurn(messages, text) ? planComputerTurn(text) : null;
    if (!plan) {
      yield* this.#inner.stream(messages, input);
      return;
    }
    // This turn never reaches the router. Drop a decision left by an earlier call
    // so the scripted reply is not stamped with that tier.
    const inner = this.#inner as { lastDecision?: unknown };
    if ("lastDecision" in inner) inner.lastDecision = null;

    const next = plan[toolResultsSinceUser(messages)];
    if (!next) {
      for (const piece of chunk(summarize(plan), 48)) {
        await sleep(this.#delayMs, signal);
        if (signal?.aborted) return;
        yield { type: "text", text: piece };
      }
      if (signal?.aborted) return;
      yield { type: "end", finishReason: "stop" };
      return;
    }

    const id = `call_${next.name}_${toolResultsSinceUser(messages)}`;
    if (signal?.aborted) return;
    yield { type: "tool_call", index: 0, id, name: next.name };
    await sleep(this.#delayMs, signal);
    if (signal?.aborted) return;
    yield { type: "tool_call", index: 0, arguments: JSON.stringify(next.args) };
    if (signal?.aborted) return;
    yield { type: "end", finishReason: "tool_calls" };
  }
}

/** Delegate phrases and child turns belong to the agent mock, including `use_computer`. */
function ownsComputerTurn(messages: readonly LlmMessage[], text: string): boolean {
  if (parseDelegatePhrase(text)) return false;
  const system = messages.find((message) => message.role === "system")?.content ?? "";
  return !system.includes("delegation: child");
}

function toolResultsSinceUser(messages: LlmMessage[]): number {
  let count = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role === "user") break;
    if (message.role === "tool") count += 1;
  }
  return count;
}

function summarize(actions: ComputerAction[]): string {
  const lines = ["The sandbox computer ran this request.", ""];
  for (const action of actions) {
    if (action.name === "write") lines.push(`Wrote \`${action.args.path}\`.`, "");
    if (action.name === "read") lines.push(`Read \`${action.args.path}\`.`, "");
    if (action.name === "list") lines.push("Listed the workspace.", "");
    if (action.name === "exec") lines.push(`Command: \`${action.args.command}\`.`, "");
  }
  return lines.join("\n").trim();
}

function chunk(text: string, size: number): string[] {
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
