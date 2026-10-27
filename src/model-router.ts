import type { Sql } from "./db/sql";
import { streamOptions, type LlmProvider, type StreamOptions } from "./llm";
import { estimateTokens } from "./memory/tokens";
import { logModelRoute, type ModelRouteEvent } from "./run-events";
import { planComputerTurn } from "./sandbox/plan";
import type { LlmMessage, LlmStreamEvent, ProviderId } from "./types";

export type ModelTier = "cheap" | "strong";
export type RouteReason = "chat" | "tool" | "plan" | "code" | "retry";

export type RouterToolCall = {
  name: string;
  arguments?: string;
};

/** What the router is allowed to see. Rules read this object. There is no classifier model. */
export type RouterTurn = {
  text: string;
  toolCalls?: readonly RouterToolCall[];
  /** True when this request repeats work after a failed attempt. */
  retryAfterFailure?: boolean;
};

export type TierRates = {
  id: string;
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  /** Completion cap sent as max_tokens. OpenRouter otherwise reserves the model maximum. */
  maxTokens: number;
};

export type RouterConfig = {
  cheap: TierRates;
  strong: TierRates;
};

export type RouteDecision = {
  tier: ModelTier;
  reason: RouteReason;
  model: string;
};

/**
 * Open-weights ids used when the base URL is OpenRouter, or when a tier var is unset there.
 * Prices are OpenRouter list prices (USD per million tokens) used to log cost, not a live bill.
 * Cheap: DeepSeek V4.1 Flash, $0.30 / $1.20. Strong: Kimi K3.1 Pro, $2 / $10.
 */
export const DEFAULT_ROUTER_CONFIG: RouterConfig = {
  cheap: {
    id: "deepseek/deepseek-v4.1-flash",
    inputUsdPerMillion: 0.3,
    outputUsdPerMillion: 1.2,
    maxTokens: 4096,
  },
  strong: {
    id: "moonshotai/kimi-k3.1-pro",
    inputUsdPerMillion: 2,
    outputUsdPerMillion: 10,
    // The strong model's own maximum is 65536. Requesting that makes OpenRouter
    // reserve more credit than a small balance can cover and return 402.
    maxTokens: 8192,
  },
};

/** Same fallback as the OpenAI-compatible provider when LLM_MODEL is unset. */
const PROVIDER_MODEL_FALLBACK = "gpt-4o-mini";

const OPEN_WEIGHT_PREFIXES = [
  "deepseek/",
  "qwen/",
  "meta-llama/",
  "mistralai/",
  "mistral/",
  "google/gemma",
  "moonshotai/",
  "nvidia/",
  "microsoft/phi",
  "z-ai/",
  "zai-org/",
  "openai/gpt-oss",
  "allenai/",
  "huggingface/",
];

const CODE_TOOLS = new Set([
  "exec",
  "write",
  "bash",
  "python",
  "shell",
  "apply_patch",
  "edit",
  "edit_file",
  "code",
]);

const CODE_TEXT =
  /\b(implement|refactor|debug|typescript|javascript|python|unit tests?|compile|bugfix|patch the|write (a |the )?(function|class|module|script|program|parser))\b/i;

const PLAN_TEXT =
  /\b(plan|plans|roadmap|architecture|design doc|break (this|it) down|step[- ]by[- ]step)\b/i;

const RETRY_TEXT = /\b(retry|try again)\b/i;

const NAMED_CALL = /^Call\s+([A-Za-z_][A-Za-z0-9_-]*)\s+(\{[\s\S]*\})\s*$/;

export function assertOpenWeights(id: string): void {
  const normalized = id.trim().toLowerCase();
  const open = OPEN_WEIGHT_PREFIXES.some((prefix) => normalized.startsWith(prefix));
  if (!normalized || normalized.includes(" ") || !open) {
    throw new Error(
      `Model id "${id}" is not an open-weights tier. Set MODEL_TIER_CHEAP and MODEL_TIER_STRONG to open-weights ids.`,
    );
  }
}

assertOpenWeights(DEFAULT_ROUTER_CONFIG.cheap.id);
assertOpenWeights(DEFAULT_ROUTER_CONFIG.strong.id);

export function loadRouterConfig(
  env: Record<string, string | undefined> = process.env,
): RouterConfig {
  return {
    cheap: tierRates(
      env.MODEL_TIER_CHEAP,
      env.MODEL_TIER_CHEAP_INPUT_USD_PER_MTOK,
      env.MODEL_TIER_CHEAP_OUTPUT_USD_PER_MTOK,
      env.MODEL_TIER_CHEAP_MAX_TOKENS,
      DEFAULT_ROUTER_CONFIG.cheap,
      env,
    ),
    strong: tierRates(
      env.MODEL_TIER_STRONG,
      env.MODEL_TIER_STRONG_INPUT_USD_PER_MTOK,
      env.MODEL_TIER_STRONG_OUTPUT_USD_PER_MTOK,
      env.MODEL_TIER_STRONG_MAX_TOKENS,
      DEFAULT_ROUTER_CONFIG.strong,
      env,
    ),
  };
}

function tierRates(
  explicitId: string | undefined,
  explicitInput: string | undefined,
  explicitOutput: string | undefined,
  explicitMaxTokens: string | undefined,
  openWeights: TierRates,
  env: Record<string, string | undefined>,
): TierRates {
  const id = resolveTierId(explicitId, openWeights.id, env);
  // List prices belong to the open-weights default. A fallback id (LLM_MODEL)
  // keeps them only when the operator sets MODEL_TIER_*_USD_PER_MTOK.
  const listed = id === openWeights.id;
  return {
    id,
    inputUsdPerMillion: readRate(explicitInput, listed ? openWeights.inputUsdPerMillion : 0),
    outputUsdPerMillion: readRate(explicitOutput, listed ? openWeights.outputUsdPerMillion : 0),
    maxTokens: readMaxTokens(explicitMaxTokens, openWeights.maxTokens),
  };
}

/**
 * An explicit MODEL_TIER_* id wins. Otherwise an OpenRouter base URL uses the
 * open-weights default. Any other base URL keeps LLM_MODEL, so a non-OpenRouter
 * server is not sent an OpenRouter-style id.
 */
function resolveTierId(
  explicit: string | undefined,
  openWeightsDefault: string,
  env: Record<string, string | undefined>,
): string {
  const configured = explicit?.trim();
  if (configured) {
    assertOpenWeights(configured);
    return configured;
  }
  if (isOpenRouterBase(env.LLM_BASE_URL)) return openWeightsDefault;
  return env.LLM_MODEL?.trim() || PROVIDER_MODEL_FALLBACK;
}

/**
 * Explicit tier ids and the open-weights defaults must stay open-weights.
 * The LLM_MODEL fallback is the provider's own model, including a closed id
 * on a non-OpenRouter server, so constructing the router must not reject it.
 */
function assertRoutableTier(id: string, env: Record<string, string | undefined>): void {
  if (id === (env.LLM_MODEL?.trim() || PROVIDER_MODEL_FALLBACK)) return;
  assertOpenWeights(id);
}

export function isOpenRouterBase(value: string | undefined): boolean {
  const trimmed = value?.trim();
  if (!trimmed) return false;
  try {
    const url = new URL(trimmed);
    return url.hostname === "openrouter.ai" || url.hostname.endsWith(".openrouter.ai");
  } catch {
    return false;
  }
}

/**
 * Select a tier from rules, in order:
 * retry after a failure, code task, plan, simple tool call, chat.
 */
export function pickModel(
  turn: RouterTurn,
  config: RouterConfig = loadRouterConfig(),
): RouteDecision {
  const tools = toolsForTurn(turn);
  if (turn.retryAfterFailure) return decide("strong", "retry", config);
  if (isCode(turn.text, tools)) return decide("strong", "code", config);
  if (PLAN_TEXT.test(turn.text)) return decide("strong", "plan", config);
  if (tools.length > 0) return decide("cheap", "tool", config);
  return decide("cheap", "chat", config);
}

export function describeTurn(
  messages: readonly LlmMessage[],
  hint?: { retryAfterFailure?: boolean },
): RouterTurn {
  let lastUser = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      lastUser = index;
      break;
    }
  }
  const text = lastUser >= 0 ? (messages[lastUser]?.content ?? "") : "";
  const toolCalls: RouterToolCall[] = [];
  let failedThisRound = false;
  let failedEarlier = false;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message) continue;
    if (message.failed && (message.role === "tool" || message.role === "assistant")) {
      if (index > lastUser) failedThisRound = true;
      else failedEarlier = true;
    }
    if (index <= lastUser || message.role !== "assistant" || !message.tool_calls) continue;
    for (const call of message.tool_calls) {
      toolCalls.push({ name: call.function.name, arguments: call.function.arguments });
    }
  }
  const asksRetry = RETRY_TEXT.test(text);
  return {
    text,
    toolCalls,
    retryAfterFailure: Boolean(
      hint?.retryAfterFailure || failedThisRound || (asksRetry && failedEarlier),
    ),
  };
}

export function costUsd(
  rates: Pick<TierRates, "inputUsdPerMillion" | "outputUsdPerMillion">,
  usage: { inputTokens: number; outputTokens: number },
): number {
  return (
    (usage.inputTokens * rates.inputUsdPerMillion +
      usage.outputTokens * rates.outputUsdPerMillion) /
    1_000_000
  );
}

export const SAMPLE_TURNS: readonly RouterTurn[] = [
  { text: "Hey, what can you help me with today?" },
  {
    text: "Search for the latest mockbot notes",
    toolCalls: [{ name: "web_search", arguments: '{"query":"mockbot notes"}' }],
  },
  {
    text: "What is on my calendar this afternoon?",
    toolCalls: [{ name: "google_calendar", arguments: '{"action":"list"}' }],
  },
  { text: "Write a plan for moving the agent loop off the request thread." },
  {
    text: "Implement the parser in TypeScript and add unit tests.",
    toolCalls: [{ name: "write", arguments: '{"path":"parser.ts","content":"export {}"}' }],
  },
  {
    text: "Implement the parser in TypeScript and add unit tests.",
    toolCalls: [{ name: "exec", arguments: '{"command":"npm test"}' }],
    retryAfterFailure: true,
  },
];

export type CostTurn = {
  tier: ModelTier;
  reason: RouteReason;
  model: string;
  costUsd: number;
  strongUsd: number;
  inputTokens: number;
  outputTokens: number;
};

export type CostReport = {
  turns: CostTurn[];
  routedUsd: number;
  allStrongUsd: number;
  savingsUsd: number;
  savingsPercent: number;
};

export function reportFromEvents(
  events: readonly ModelRouteEvent[],
  config: RouterConfig,
): CostReport {
  const turns: CostTurn[] = events.map((event) => {
    const usage = { inputTokens: event.inputTokens, outputTokens: event.outputTokens };
    return {
      tier: event.tier,
      reason: event.reason,
      model: event.model,
      costUsd: event.costUsd,
      strongUsd: costUsd(config.strong, usage),
      inputTokens: event.inputTokens,
      outputTokens: event.outputTokens,
    };
  });
  return summarize(turns);
}

export function formatCostReport(report: CostReport): string {
  const lines = [
    "turn  reason  tier    model                          routed_usd    all_strong_usd",
  ];
  report.turns.forEach((turn, index) => {
    lines.push(
      [
        String(index + 1).padEnd(5),
        turn.reason.padEnd(7),
        turn.tier.padEnd(7),
        turn.model.padEnd(30),
        formatUsd(turn.costUsd).padEnd(13),
        formatUsd(turn.strongUsd),
      ].join(" "),
    );
  });
  lines.push(`routed ${formatUsd(report.routedUsd)}`);
  lines.push(`all-strong ${formatUsd(report.allStrongUsd)}`);
  lines.push(`savings ${formatUsd(report.savingsUsd)} (${report.savingsPercent.toFixed(2)}%)`);
  return lines.join("\n");
}

export function formatUsd(value: number): string {
  return `$${value.toFixed(8)}`;
}

/** Replay the sample turns through a routed provider and price them against an all-strong baseline. */
export async function runRoutedSample(provider: RoutingProvider): Promise<CostReport> {
  const events: ModelRouteEvent[] = [];
  for (const turn of SAMPLE_TURNS) {
    const messages = messagesForTurn(turn);
    for await (const _event of provider.stream(messages, {
      retryAfterFailure: turn.retryAfterFailure,
    })) {
      // The mock provider is consumed so output tokens match a real turn.
    }
    const logged = provider.lastEvent;
    if (logged) events.push(logged);
  }
  return reportFromEvents(events, provider.config);
}

export function messagesForTurn(turn: RouterTurn): LlmMessage[] {
  const messages: LlmMessage[] = [{ role: "user", content: turn.text }];
  if (!turn.toolCalls?.length) return messages;
  messages.push({
    role: "assistant",
    content: "",
    tool_calls: turn.toolCalls.map((call, index) => ({
      id: `call_${index}`,
      type: "function",
      function: { name: call.name, arguments: call.arguments ?? "{}" },
    })),
  });
  return messages;
}

export class RoutingProvider implements LlmProvider {
  readonly #inner: LlmProvider;
  readonly #config: RouterConfig;
  readonly #db: Sql | null;
  lastEvent: ModelRouteEvent | null = null;

  constructor(options: { inner: LlmProvider; config?: RouterConfig; db?: Sql | null }) {
    this.#inner = options.inner;
    this.#config = options.config ?? loadRouterConfig();
    assertRoutableTier(this.#config.cheap.id, process.env);
    assertRoutableTier(this.#config.strong.id, process.env);
    this.#db = options.db ?? null;
  }

  get id(): ProviderId {
    return this.#inner.id;
  }

  get model(): string | null {
    return this.#inner.model;
  }

  get config(): RouterConfig {
    return this.#config;
  }

  /**
   * The decision is attached to this call's iterable. Concurrent requests each
   * get their own object, so one turn cannot stamp the other's tier.
   */
  stream(
    messages: LlmMessage[],
    input?: StreamOptions | AbortSignal,
  ): AsyncIterable<LlmStreamEvent> & { decision: RouteDecision } {
    const options = streamOptions(input);
    const turn = describeTurn(messages, { retryAfterFailure: options.retryAfterFailure });
    const decision = pickModel(turn, this.#config);
    const inner = this.#inner;
    const config = this.#config;
    const db = this.#db;
    const record = (event: ModelRouteEvent) => {
      this.lastEvent = event;
    };
    async function* generate(): AsyncIterable<LlmStreamEvent> {
      let outputTokens = 0;
      try {
        // First event, so a wrapper that only yield*s still delivers this turn's tier.
        yield {
          type: "route",
          tier: decision.tier,
          reason: decision.reason,
          model: decision.model,
        };
        for await (const event of inner.stream(messages, {
          ...options,
          model: decision.model,
          maxTokens: config[decision.tier].maxTokens,
        })) {
          outputTokens += outputTokensFrom(event);
          yield event;
        }
      } finally {
        const usage = { inputTokens: inputTokensFrom(messages), outputTokens };
        const event: ModelRouteEvent = {
          id: `route_${crypto.randomUUID()}`,
          kind: "model.route",
          tier: decision.tier,
          reason: decision.reason,
          model: decision.model,
          costUsd: costUsd(config[decision.tier], usage),
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          ...(options.conversationId ? { conversationId: options.conversationId } : {}),
        };
        record(event);
        options.onRoute?.(event);
        console.info(
          `model route tier=${event.tier} reason=${event.reason} model=${event.model} costUsd=${event.costUsd}`,
        );
        try {
          await logModelRoute(event, db);
        } catch {
          // The helper already swallows storage errors. This keeps a turn alive
          // if the logger itself is missing.
        }
      }
    }
    return Object.assign(generate(), { decision });
  }
}

export function streamDecision(stream: AsyncIterable<LlmStreamEvent>): RouteDecision | undefined {
  const decision = (stream as AsyncIterable<LlmStreamEvent> & { decision?: RouteDecision })
    .decision;
  if (!decision?.model) return undefined;
  return decision;
}

function decide(tier: ModelTier, reason: RouteReason, config: RouterConfig): RouteDecision {
  return { tier, reason, model: config[tier].id };
}

function toolsForTurn(turn: RouterTurn): RouterToolCall[] {
  const tools = [...(turn.toolCalls ?? [])];
  for (const implied of impliedTools(turn.text)) {
    if (!tools.some((tool) => tool.name === implied.name)) tools.push(implied);
  }
  return tools;
}

const COMMANDS = new Set([
  "npm",
  "npx",
  "yarn",
  "pnpm",
  "bun",
  "node",
  "python",
  "python3",
  "pip",
  "git",
  "cargo",
  "go",
  "make",
  "gcc",
  "clang",
  "curl",
  "wget",
  "bash",
  "sh",
  "zsh",
  "ls",
  "cat",
  "echo",
  "mkdir",
  "rm",
  "cp",
  "mv",
  "docker",
  "kubectl",
  "psql",
  "tsc",
  "vitest",
  "eslint",
  "prettier",
  "pytest",
  "ruby",
  "perl",
  "java",
  "javac",
  "rustc",
]);

function impliedTools(text: string): RouterToolCall[] {
  const named = NAMED_CALL.exec(text.trim());
  if (named?.[1]) return [{ name: named[1], arguments: named[2] }];
  const computer = planComputerTurn(text) ?? [];
  const command = runCommand(text);
  // planComputerTurn treats any backtick span as an exec. A mention such as
  // "what does `npm ci` do?" is still chat, and so is "run a search".
  const actions = computer.filter((action) => action.name !== "exec" || command != null);
  if (!actions.some((action) => action.name === "exec") && command) {
    actions.push({ name: "exec", args: { command } });
  }
  return actions.map((action) => ({ name: action.name, arguments: JSON.stringify(action.args) }));
}

function runCommand(text: string): string | null {
  const prose = text.replace(/`[^`\n]*`/g, " ");
  const plain = prose.match(/\b(?:run|exec|execute)\s+(.+)$/i);
  if (plain?.[1]) {
    const command = plain[1].replace(/[.?!]+$/, "").trim();
    const token = command.split(/\s+/)[0]?.replace(/^['"]+|['",.]+$/g, "") ?? "";
    if (command && isCommandToken(token)) return command;
  }
  if (!/\b(?:run|exec|execute)\b/i.test(prose)) return null;
  const quoted = text.match(/`([^`\n]+)`/)?.[1]?.trim();
  if (!quoted) return null;
  const token = quoted.split(/\s+/)[0] ?? "";
  return isCommandToken(token) ? quoted : null;
}

function isCommandToken(token: string): boolean {
  if (!token) return false;
  if (COMMANDS.has(token.toLowerCase())) return true;
  if (token.startsWith("./") || token.startsWith("/") || token.includes("/")) return true;
  return /\.(sh|py|js|ts|mjs|cjs)$/i.test(token);
}

function isCode(text: string, tools: readonly RouterToolCall[]): boolean {
  if (tools.some((tool) => CODE_TOOLS.has(tool.name))) return true;
  return CODE_TEXT.test(text);
}

function readRate(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(
      `Model tier price "${value}" must be a non-negative number of USD per million tokens.`,
    );
  }
  return parsed;
}

function readMaxTokens(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 16384) {
    throw new Error(`Model tier max tokens "${value}" must be an integer from 1 to 16384.`);
  }
  return parsed;
}

function inputTokensFrom(messages: readonly LlmMessage[]): number {
  let tokens = 0;
  for (const message of messages) {
    tokens += estimateTokens(message.content);
    for (const call of message.tool_calls ?? []) {
      tokens += estimateTokens(`${call.function.name}${call.function.arguments}`);
    }
  }
  return tokens;
}

function outputTokensFrom(event: LlmStreamEvent): number {
  if (event.type === "text" || event.type === "reasoning") return estimateTokens(event.text);
  if (event.type === "tool_call")
    return estimateTokens(`${event.name ?? ""}${event.arguments ?? ""}`);
  return 0;
}

function summarize(turns: CostTurn[]): CostReport {
  const routedUsd = turns.reduce((sum, turn) => sum + turn.costUsd, 0);
  const allStrongUsd = turns.reduce((sum, turn) => sum + turn.strongUsd, 0);
  const savingsUsd = allStrongUsd - routedUsd;
  const savingsPercent = allStrongUsd === 0 ? 0 : (savingsUsd / allStrongUsd) * 100;
  return { turns, routedUsd, allStrongUsd, savingsUsd, savingsPercent };
}
