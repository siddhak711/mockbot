import type { ToolDefinition } from "./types";

export const PROPOSE_PLAN_TOOL = "propose_plan";

export const PLAN_UNATTENDED =
  "This routine has nobody to approve a plan, so the plan was not run.";

const MAX_STEPS = 7;
const MAX_TITLE = 120;
const MAX_DETAIL = 400;

export type PlanStepState = "pending" | "active" | "done";

export type PlanStep = {
  title: string;
  detail: string;
  state: PlanStepState;
};

export type PlanOutcome =
  { reason: "approved"; steps: PlanStep[] } | { reason: "cancelled" } | { reason: "timeout" };

const STEP_COMMAND = /^Execute step (\d+) only: ([^\n]*)\n([\s\S]*)$/;

export function parseStepCommand(
  text: string,
): { index: number; title: string; detail: string } | null {
  const match = text.match(STEP_COMMAND);
  if (!match) return null;
  const index = Number(match[1]) - 1;
  if (!Number.isInteger(index) || index < 0) return null;
  return { index, title: (match[2] ?? "").trim(), detail: (match[3] ?? "").trim() };
}

export function stepCommand(step: PlanStep, index: number): string {
  return `Execute step ${index + 1} only: ${step.title}\n${step.detail}`;
}

export function approvedPlanMessage(steps: readonly PlanStep[]): string {
  const lines = steps.map((step, index) => `${index + 1}. ${step.title} — ${step.detail}`);
  return `Approved plan. Execute only the step in the latest user message.\n${lines.join("\n")}`;
}

export function formatPlanText(steps: readonly PlanStep[]): string {
  return steps.map((step) => `${step.title} — ${step.detail}`).join("\n");
}

function cleanStep(title: string, detail: string, state?: PlanStepState): PlanStep | null {
  const nextTitle = title.trim();
  const nextDetail = detail.trim() || nextTitle;
  if (!nextTitle || nextTitle.length > MAX_TITLE || nextDetail.length > MAX_DETAIL) return null;
  const nextState: PlanStepState =
    state === "active" || state === "done" || state === "pending" ? state : "pending";
  return { title: nextTitle, detail: nextDetail, state: nextState };
}

export function parsePlanSteps(
  value: unknown,
): { ok: true; steps: PlanStep[] } | { ok: false; error: string } {
  const record =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as { steps?: unknown })
      : null;
  const rawSteps = Array.isArray(value) ? value : record?.steps;
  if (!Array.isArray(rawSteps)) {
    return { ok: false, error: "A plan needs a steps array." };
  }
  if (rawSteps.length === 0) return { ok: false, error: "A plan needs at least one step." };
  if (rawSteps.length > MAX_STEPS) {
    return { ok: false, error: `A plan accepts at most ${MAX_STEPS} steps.` };
  }
  const steps: PlanStep[] = [];
  for (const raw of rawSteps) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return { ok: false, error: "Each plan step needs a title and a detail." };
    }
    const step = raw as { title?: unknown; detail?: unknown; state?: unknown };
    if (typeof step.title !== "string") {
      return { ok: false, error: "Each plan step needs a title." };
    }
    const detail = typeof step.detail === "string" ? step.detail : step.title;
    const state = step.state === "active" || step.state === "done" ? step.state : "pending";
    const cleaned = cleanStep(step.title, detail, state);
    if (!cleaned) return { ok: false, error: "A plan step is empty or too long." };
    steps.push(cleaned);
  }
  return { ok: true, steps };
}

export function parsePlan(
  raw: string,
): { ok: true; steps: PlanStep[] } | { ok: false; error: string } {
  if (!raw.trim()) return { ok: false, error: "A plan needs a steps array." };
  try {
    return parsePlanSteps(JSON.parse(raw) as unknown);
  } catch {
    return { ok: false, error: "Plan arguments were not valid JSON." };
  }
}

export function readPlan(raw: string): { steps: PlanStep[] } | null {
  const parsed = parsePlan(raw);
  return parsed.ok ? { steps: parsed.steps } : null;
}

/** Free-text edit: one step per line, `title — detail`. */
export function parsePlanText(
  text: string,
): { ok: true; steps: PlanStep[] } | { ok: false; error: string } {
  const lines = text
    .split(/\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^\d+[.)]\s+/, "").replace(/^[-*]\s+/, ""));
  if (lines.length === 0) return { ok: false, error: "Write at least one step." };
  const raw = lines.map((line) => {
    const parts = line.split(/\s+(?:—|\|)\s+|\s+-\s+/);
    const title = parts[0] ?? "";
    const detail = parts.slice(1).join(" - ");
    return { title, detail };
  });
  return parsePlanSteps(raw);
}

function listItems(userText: string): string[] {
  return userText
    .split(/\n/)
    .map((line) => line.trim())
    .filter((line) => /^(?:\d+[.)]|[-*])\s+\S/.test(line));
}

/** The mock model's estimate. Three or more listed steps is a big task. */
export function estimatePlan(userText: string): PlanStep[] | null {
  const explicit = userText.trim().match(/^Plan\s+(\{[\s\S]*\})$/);
  if (explicit?.[1]) {
    const parsed = parsePlan(explicit[1]);
    if (parsed.ok && parsed.steps.length >= 3) {
      return parsed.steps.map((step) => ({ ...step, state: "pending" }));
    }
    return null;
  }
  const items = listItems(userText);
  if (items.length < 3) return null;
  const parsed = parsePlanText(items.join("\n"));
  return parsed.ok ? parsed.steps : null;
}

export function fallbackPlan(userText: string): PlanStep[] {
  const estimated = estimatePlan(userText);
  if (estimated) return estimated;
  const task = userText.replace(/\s+/g, " ").trim().slice(0, 160) || "the request";
  return [
    { title: "Understand the request", detail: task, state: "pending" },
    { title: "Do the work", detail: task, state: "pending" },
    { title: "Report the result", detail: task, state: "pending" },
  ];
}

export function mockPlanCall(userText: string, forced: boolean): { steps: PlanStep[] } | null {
  if (parseStepCommand(userText)) return null;
  const named = userText.trim().match(/^Call\s+propose_plan\s+(\{[\s\S]*\})$/);
  if (named?.[1]) {
    const parsed = parsePlan(named[1]);
    if (parsed.ok) return { steps: parsed.steps.map((step) => ({ ...step, state: "pending" })) };
    return null;
  }
  const estimated = estimatePlan(userText);
  if (estimated) return { steps: estimated };
  if (forced) return { steps: fallbackPlan(userText) };
  return null;
}

export function shouldDeferToPlanModel(userText: string, plan: boolean): boolean {
  if (parseStepCommand(userText)) return true;
  if (plan) return true;
  if (/^Call\s+propose_plan\s+\{/.test(userText.trim())) return true;
  return estimatePlan(userText) != null;
}

export function proposePlanTool(): ToolDefinition {
  return {
    name: PROPOSE_PLAN_TOOL,
    description:
      "Propose an ordered plan and wait for the person to approve it. Pass steps as an array of { title, detail }. Call this before any other tool when the task needs three or more steps, or when Plan mode is on. Nothing else runs until they approve.",
    exposure: "pinned",
    approval: "never",
    skipHeuristicApproval: true,
    inputSchema: {
      type: "object",
      properties: {
        steps: {
          type: "array",
          description: 'Steps to approve. Each item is {"title","detail"}.',
          items: { type: "object" },
        },
      },
      required: ["steps"],
      additionalProperties: false,
    },
    prepare(args) {
      const parsed = parsePlanSteps(args);
      if (!parsed.ok) return { error: parsed.error };
      return {
        args: {
          steps: parsed.steps.map((step) => ({ title: step.title, detail: step.detail })),
        },
      };
    },
    async invoke() {
      return {
        content: "propose_plan waits in the chat loop and does not run on its own.",
        isError: true,
      };
    },
  };
}

type Waiter = {
  resolve: (outcome: PlanOutcome) => void;
  conversationId: string;
  messageId: string;
  steps: PlanStep[];
};

export class PlanGate {
  #waiters = new Map<string, Waiter>();

  constructor(private readonly timeoutMs = 5 * 60 * 1000) {}

  wait(
    id: string,
    steps: PlanStep[],
    conversationId: string,
    messageId: string,
  ): Promise<PlanOutcome> {
    if (this.#waiters.has(id)) {
      return Promise.reject(new Error(`Plan ${id} is already pending`));
    }
    return new Promise((resolve) => {
      let settled = false;
      const finish = (outcome: PlanOutcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.#waiters.delete(id);
        resolve(outcome);
      };
      const timer = setTimeout(() => finish({ reason: "timeout" }), this.timeoutMs);
      this.#waiters.set(id, {
        resolve: finish,
        conversationId,
        messageId,
        steps: steps.map((step) => ({ ...step })),
      });
    });
  }

  pendingConversation(id: string): string | null {
    return this.#waiters.get(id)?.conversationId ?? null;
  }

  snapshot(id: string): { conversationId: string; messageId: string; steps: PlanStep[] } | null {
    const waiter = this.#waiters.get(id);
    if (!waiter) return null;
    return {
      conversationId: waiter.conversationId,
      messageId: waiter.messageId,
      steps: waiter.steps.map((step) => ({ ...step })),
    };
  }

  hasPending(conversationId: string): boolean {
    for (const waiter of this.#waiters.values()) {
      if (waiter.conversationId === conversationId) return true;
    }
    return false;
  }

  edit(id: string, steps: PlanStep[]): "ok" | "missing" | "rejected" {
    const waiter = this.#waiters.get(id);
    if (!waiter) return "missing";
    if (steps.length === 0 || steps.length > MAX_STEPS) return "rejected";
    const next = steps.map((step) => cleanStep(step.title, step.detail, "pending"));
    if (next.some((step) => !step)) return "rejected";
    waiter.steps = next as PlanStep[];
    return "ok";
  }

  approve(id: string): "ok" | "missing" {
    const waiter = this.#waiters.get(id);
    if (!waiter) return "missing";
    waiter.resolve({ reason: "approved", steps: waiter.steps.map((step) => ({ ...step })) });
    return "ok";
  }

  cancel(id: string): boolean {
    const waiter = this.#waiters.get(id);
    if (!waiter) return false;
    waiter.resolve({ reason: "cancelled" });
    return true;
  }
}
