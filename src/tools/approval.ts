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
  id: string;
  resolve: (outcome: ApprovalOutcome) => void;
  conversationId: string | null;
};

/**
 * Pending approvals keyed by (conversation, tool-call id). Providers reuse call
 * ids such as `call_delegate`, so the id alone does not name one call.
 */
export class ApprovalGate {
  #waiters = new Map<string, Waiter>();

  constructor(private readonly timeoutMs = 5 * 60 * 1000) {}

  wait(id: string, signal?: AbortSignal, conversationId?: string): Promise<ApprovalOutcome> {
    const key = waiterKey(conversationId ?? null, id);
    if (this.#waiters.has(key)) {
      return Promise.reject(new Error(`Approval ${id} is already pending`));
    }
    return new Promise((resolve) => {
      let settled = false;
      const finish = (outcome: ApprovalOutcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.#waiters.delete(key);
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
      this.#waiters.set(key, { id, resolve: finish, conversationId: conversationId ?? null });
    });
  }

  /** Conversations with a pending call under this id. */
  pendingConversations(id: string): (string | null)[] {
    const found: (string | null)[] = [];
    for (const waiter of this.#waiters.values()) {
      if (waiter.id === id) found.push(waiter.conversationId);
    }
    return found;
  }

  hasPending(conversationId: string): boolean {
    for (const waiter of this.#waiters.values()) {
      if (waiter.conversationId === conversationId) return true;
    }
    return false;
  }

  /**
   * Settles the call `id` in `conversationId`. Leaving the conversation out
   * works only while exactly one conversation waits on that id.
   */
  decide(id: string, decision: ApprovalDecision, conversationId?: string | null): boolean {
    const waiter = this.#find(id, conversationId);
    if (!waiter) return false;
    waiter.resolve({ decision, reason: "user" });
    return true;
  }

  stop(id: string, conversationId?: string | null): boolean {
    const waiter = this.#find(id, conversationId);
    if (!waiter) return false;
    waiter.resolve({ decision: "deny", reason: "stopped" });
    return true;
  }

  #find(id: string, conversationId: string | null | undefined): Waiter | undefined {
    if (conversationId !== undefined) return this.#waiters.get(waiterKey(conversationId, id));
    const matches = [...this.#waiters.values()].filter((waiter) => waiter.id === id);
    return matches.length === 1 ? matches[0] : undefined;
  }
}

function waiterKey(conversationId: string | null, id: string): string {
  return JSON.stringify([conversationId, id]);
}
