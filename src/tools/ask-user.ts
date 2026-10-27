import type { ToolDefinition } from "./types";

export const ASK_USER_TOOL = "ask_user";

export const ASK_UNATTENDED = "This routine has nobody to ask, so ask_user was not run.";

export const ASK_EXPIRED = "This question expired.";

const MAX_QUESTION = 500;
const MAX_OPTIONS = 8;
const MAX_OPTION = 200;
const MAX_ANSWER = 2_000;

export type AskUserRequest = {
  question: string;
  options: string[];
  allowCustom: boolean;
};

export type AskOutcome =
  { reason: "user"; answer: string } | { reason: "stopped" } | { reason: "timeout" };

export function parseAskUser(
  args: Record<string, unknown>,
): { ok: true; request: AskUserRequest } | { ok: false; error: string } {
  const question = typeof args.question === "string" ? args.question.trim() : "";
  if (!question) return { ok: false, error: "ask_user requires a question." };
  if (question.length > MAX_QUESTION) {
    return { ok: false, error: "ask_user question is too long." };
  }
  if (!Array.isArray(args.options)) {
    return { ok: false, error: "ask_user requires an options array." };
  }
  const options: string[] = [];
  for (const option of args.options) {
    if (typeof option !== "string") {
      return { ok: false, error: "ask_user options must be strings." };
    }
    const text = option.trim();
    if (!text) continue;
    if (text.length > MAX_OPTION) return { ok: false, error: "ask_user option is too long." };
    if (!options.includes(text)) options.push(text);
    if (options.length > MAX_OPTIONS) {
      return { ok: false, error: `ask_user accepts at most ${MAX_OPTIONS} options.` };
    }
  }
  const allowCustom = args.allowCustom === true;
  if (options.length === 0 && !allowCustom) {
    return { ok: false, error: "ask_user needs at least one option, or allowCustom set to true." };
  }
  return { ok: true, request: { question, options, allowCustom } };
}

export function acceptedAskAnswer(request: AskUserRequest, answer: string): string | null {
  const text = answer.trim();
  if (!text || text.length > MAX_ANSWER) return null;
  if (request.options.includes(text) || request.allowCustom) return text;
  return null;
}

export function readAskUser(raw: string): AskUserRequest | null {
  if (!raw.trim()) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const parsed = parseAskUser(value as Record<string, unknown>);
    return parsed.ok ? parsed.request : null;
  } catch {
    return null;
  }
}

export function askUserTool(): ToolDefinition {
  return {
    name: ASK_USER_TOOL,
    description:
      "Ask the person a question and wait until they answer. Pass a short question, options they can tap, and allowCustom when they may type their own answer. The tool result is the answer they gave.",
    exposure: "pinned",
    approval: "never",
    skipHeuristicApproval: true,
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", description: "Question shown on the card" },
        options: {
          type: "array",
          description: "Answers the person can tap",
          items: { type: "string" },
        },
        allowCustom: {
          type: "boolean",
          description: "When true, the card also accepts a typed answer",
        },
      },
      required: ["question", "options"],
      additionalProperties: false,
    },
    prepare(args) {
      const parsed = parseAskUser(args);
      if (!parsed.ok) return { error: parsed.error };
      return { args: { ...parsed.request } };
    },
    async invoke() {
      return {
        content: "ask_user waits in the chat loop and does not run on its own.",
        isError: true,
      };
    },
  };
}

type Waiter = {
  resolve: (outcome: AskOutcome) => void;
  conversationId: string;
  request: AskUserRequest;
};

export class AskGate {
  #waiters = new Map<string, Waiter>();

  constructor(private readonly timeoutMs = 5 * 60 * 1000) {}

  wait(id: string, request: AskUserRequest, conversationId: string): Promise<AskOutcome> {
    if (this.#waiters.has(id)) {
      return Promise.reject(new Error(`Question ${id} is already pending`));
    }
    return new Promise((resolve) => {
      let settled = false;
      const finish = (outcome: AskOutcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.#waiters.delete(id);
        resolve(outcome);
      };
      const timer = setTimeout(() => finish({ reason: "timeout" }), this.timeoutMs);
      this.#waiters.set(id, { resolve: finish, conversationId, request });
    });
  }

  pendingConversation(id: string): string | null {
    return this.#waiters.get(id)?.conversationId ?? null;
  }

  /** True when this process is blocked inside wait() for the id. */
  waiting(id: string): boolean {
    return this.#waiters.has(id);
  }

  hasPending(conversationId: string): boolean {
    for (const waiter of this.#waiters.values()) {
      if (waiter.conversationId === conversationId) return true;
    }
    return false;
  }

  answer(id: string, answer: string): "ok" | "missing" | "rejected" {
    const waiter = this.#waiters.get(id);
    if (!waiter) return "missing";
    const text = acceptedAskAnswer(waiter.request, answer);
    if (!text) return "rejected";
    waiter.resolve({ reason: "user", answer: text });
    return "ok";
  }

  stop(id: string): boolean {
    const waiter = this.#waiters.get(id);
    if (!waiter) return false;
    waiter.resolve({ reason: "stopped" });
    return true;
  }
}
