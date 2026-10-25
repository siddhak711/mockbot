import type { LlmMessage, LlmStreamEvent, ProviderId } from "../types";
import type { LlmProvider } from "../llm";
import { planComputerTurn, type ComputerAction } from "./plan";
import type { ComputerSupervisor } from "./supervisor";
import { createComputerTools } from "./tools";
import type { ComputerToolResult } from "./types";

const REASONING =
  "This asks for the sandbox computer. I should write, read, and run the command there, and I should not touch the host.";

export class SandboxTurnProvider implements LlmProvider {
  readonly #inner: LlmProvider;
  readonly #supervisor: ComputerSupervisor;
  readonly #delayMs: number;

  constructor(options: { inner: LlmProvider; supervisor: ComputerSupervisor; delayMs?: number }) {
    this.#inner = options.inner;
    this.#supervisor = options.supervisor;
    this.#delayMs = options.delayMs ?? 0;
  }

  get id(): ProviderId {
    return this.#inner.id;
  }

  get model(): string | null {
    return this.#inner.model;
  }

  async *stream(messages: LlmMessage[], signal?: AbortSignal): AsyncIterable<LlmStreamEvent> {
    const lastUser = [...messages].reverse().find((message) => message.role === "user");
    const plan = this.#inner.id === "mock" ? planComputerTurn(lastUser?.content ?? "") : null;
    if (!plan) {
      yield* this.#inner.stream(messages, signal);
      return;
    }

    const tools = new Map(createComputerTools(this.#supervisor).map((item) => [item.name, item]));
    if (signal?.aborted) return;
    yield { type: "start", role: "assistant" };
    for (const piece of chunk(REASONING, 32)) {
      await sleep(this.#delayMs, signal);
      if (signal?.aborted) return;
      yield { type: "reasoning", text: piece };
    }

    const results: ComputerToolResult[] = [];
    for (let index = 0; index < plan.length; index += 1) {
      const action = plan[index];
      if (!action) continue;
      const tool = tools.get(action.name);
      if (!tool) continue;
      const id = `call_${action.name}_${index}`;
      const argsText = JSON.stringify(action.args);
      await sleep(this.#delayMs, signal);
      if (signal?.aborted) return;
      yield { type: "tool_call", index, id, name: tool.name };
      yield { type: "tool_call", index, arguments: argsText };
      const prepared = tool.prepare(action.args);
      const result =
        "error" in prepared
          ? { content: prepared.error, isError: true }
          : await tool.invoke(prepared.args, { signal });
      results.push(result);
      if (signal?.aborted) return;
      yield { type: "tool_result", id, name: tool.name, content: result.content };
    }

    for (const piece of chunk(summarize(plan, results), 32)) {
      await sleep(this.#delayMs, signal);
      if (signal?.aborted) return;
      yield { type: "text", text: piece };
    }
    if (signal?.aborted) return;
    await sleep(this.#delayMs, signal);
    if (signal?.aborted) return;
    yield { type: "end", finishReason: "stop" };
  }
}

function summarize(actions: ComputerAction[], results: ComputerToolResult[]): string {
  const lines = ["The sandbox computer ran this request.", ""];
  actions.forEach((action, index) => {
    const result = results[index];
    if (!result) return;
    if (action.name === "exec") {
      lines.push(`Command: \`${action.args.command}\``, "", "```text", result.content, "```", "");
      return;
    }
    if (action.name === "write") lines.push(`Wrote \`${action.args.path}\`.`, "");
    if (action.name === "read") lines.push(`Read \`${action.args.path}\`.`, "");
    if (action.name === "list") lines.push("Listed the workspace.", "");
  });
  return lines.join("\n").trim();
}

function chunk(text: string, size: number): string[] {
  const width = Math.max(1, size);
  const parts: string[] = [];
  for (let index = 0; index < text.length; index += width)
    parts.push(text.slice(index, index + width));
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
