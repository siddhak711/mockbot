import type { ToolDefinition } from "./types";

export type ApprovalDecision = "approve" | "deny";

export type ApprovalReason = "user" | "timeout" | "stopped";

export type ApprovalOutcome = {
  decision: ApprovalDecision;
  reason: ApprovalReason;
};

const NAME_VERBS = /(^|_)(send|post|delete|pay)(_|$)/i;
const ACTION_VERBS = /^(send|post|delete|pay)$/i;

export function requiresApproval(tool: ToolDefinition, args: Record<string, unknown>): boolean {
  if (tool.skipHeuristicApproval) return false;
  if (tool.approval === "always") return true;
  if (NAME_VERBS.test(tool.name)) return true;
  const action = typeof args.action === "string" ? args.action : "";
  if (ACTION_VERBS.test(action)) return true;
  if (tool.approval === "never") return false;
  if (typeof tool.approval === "function") return tool.approval(args);
  return false;
}

type Waiter = {
  resolve: (outcome: ApprovalOutcome) => void;
  conversationId: string | null;
};

export class ApprovalGate {
  #waiters = new Map<string, Waiter>();

  constructor(private readonly timeoutMs = 5 * 60 * 1000) {}

  wait(id: string, signal?: AbortSignal, conversationId?: string): Promise<ApprovalOutcome> {
    if (this.#waiters.has(id)) {
      return Promise.reject(new Error(`Approval ${id} is already pending`));
    }
    return new Promise((resolve) => {
      let settled = false;
      const finish = (outcome: ApprovalOutcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.#waiters.delete(id);
        resolve(outcome);
      };
      const onAbort = () => finish({ decision: "deny", reason: "stopped" });
      const timer = setTimeout(
        () => finish({ decision: "deny", reason: "timeout" }),
        this.timeoutMs,
      );
      if (signal?.aborted) {
        finish({ decision: "deny", reason: "stopped" });
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#waiters.set(id, { resolve: finish, conversationId: conversationId ?? null });
    });
  }

  hasPending(conversationId: string): boolean {
    for (const waiter of this.#waiters.values()) {
      if (waiter.conversationId === conversationId) return true;
    }
    return false;
  }

  decide(id: string, decision: ApprovalDecision): boolean {
    const waiter = this.#waiters.get(id);
    if (!waiter) return false;
    waiter.resolve({ decision, reason: "user" });
    return true;
  }

  stop(id: string): boolean {
    const waiter = this.#waiters.get(id);
    if (!waiter) return false;
    waiter.resolve({ decision: "deny", reason: "stopped" });
    return true;
  }
}
