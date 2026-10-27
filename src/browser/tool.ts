import type { ToolDefinition, ToolResult } from "../tools/types";
import {
  DEFAULT_BROWSE_TIMEOUT_MS,
  MAX_BROWSE_ACTIONS,
  MAX_SELECTOR_CHARS,
  MAX_TYPE_CHARS,
  MAX_URL_CHARS,
} from "./limits";
import { BROWSE_ACTIONS, type BrowseAction, type BrowserDriver } from "./types";

export const BROWSE_TOOL_NAME = "browse";

const COUNTER = "browse";

/** Selectors that name a submit or login control. These ask for approval up front. */
const SUBMIT_SELECTOR = /submit|log-?in|sign-?in|password|passwd/i;

/**
 * A label click activates the labeled control. Gate it up front, the same as a
 * selector that names that control. An id on the label itself is classified in
 * the daemon, which resolves the label to its control.
 */
const LABEL_SELECTOR = /(?:^|[\s>+~,])label\b|\[for\s*=/i;

export type BrowseToolOptions = {
  /** Null when the sandbox cannot run a browser, such as the mock computer. */
  driver: () => BrowserDriver | null;
  unavailable?: string;
  actionTimeoutMs?: number;
  maxActions?: number;
  /**
   * Forces the daemon submit flag for every step.
   * Leave unset for chat browse: a submit is allowed only after this call itself was approved.
   */
  allowSubmit?: boolean;
};

/** Approval runs before submits and logins: on confirm, or when the selector names one. */
export function browseNeedsApproval(args: Record<string, unknown>): boolean {
  if (args.confirm === true) return true;
  const action = args.action;
  if (action !== "click" && action !== "type") return false;
  if (typeof args.selector !== "string") return false;
  if (SUBMIT_SELECTOR.test(args.selector)) return true;
  return action === "click" && LABEL_SELECTOR.test(args.selector);
}

export function browseTool(options: BrowseToolOptions): ToolDefinition {
  const maxActions = options.maxActions ?? MAX_BROWSE_ACTIONS;
  const timeoutMs = options.actionTimeoutMs ?? DEFAULT_BROWSE_TIMEOUT_MS;
  const ownCounters = new Map<string, number>();
  return {
    name: BROWSE_TOOL_NAME,
    description:
      `Drive a headless browser inside the sandbox. Actions: open (url), click (selector), type (selector, text), extract (optional selector), screenshot. ` +
      `At most ${maxActions} actions per run. Form submits and logins need confirm: true and the user's approval.`,
    exposure: "default",
    approval: browseNeedsApproval,
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "http or https URL for open" },
        action: { type: "string", enum: BROWSE_ACTIONS, description: "What to do" },
        selector: { type: "string", description: "CSS or Playwright selector" },
        text: { type: "string", description: "Text for type" },
        confirm: {
          type: "boolean",
          description: "Set when the action submits a form or logs in. The user approves first.",
        },
      },
      required: ["action"],
      additionalProperties: false,
    },
    prepare: prepareBrowseArgs,
    async invoke(args, context) {
      const prepared = prepareBrowseArgs(args);
      if ("error" in prepared) return { content: prepared.error, isError: true };
      const driver = options.driver();
      if (!driver) {
        return {
          content:
            options.unavailable ??
            "The browser runs inside the Daytona sandbox, which is not configured.",
          isError: true,
        };
      }
      const counters = context.runCounters ?? ownCounters;
      const used = (counters.get(COUNTER) ?? 0) + 1;
      counters.set(COUNTER, used);
      if (used > maxActions) {
        return {
          content: `Stopped: browse reached its limit of ${maxActions} actions for this run. The run ends here.`,
          isError: true,
          halt: true,
        };
      }
      const step = prepared.args;
      const action = step.action as BrowseAction;
      const outcome = await driver.perform(
        {
          action,
          ...(typeof step.url === "string" ? { url: step.url } : {}),
          ...(typeof step.selector === "string" ? { selector: step.selector } : {}),
          ...(typeof step.text === "string" ? { text: step.text } : {}),
          timeoutMs: action === "open" ? timeoutMs * 2 : timeoutMs,
          // Chat browse sets this from the selector. A caller that already passed
          // the approval card, or that must not submit, overrides it.
          allowSubmit:
            options.allowSubmit === undefined ? browseNeedsApproval(step) : options.allowSubmit,
        },
        context.signal,
      );
      return formatOutcome(action, outcome, used, maxActions);
    },
  };
}

export function prepareBrowseArgs(
  args: Record<string, unknown>,
): { args: Record<string, unknown> } | { error: string } {
  const action = typeof args.action === "string" ? args.action.trim() : "";
  if (!BROWSE_ACTIONS.includes(action as BrowseAction)) {
    return { error: `browse action must be one of: ${BROWSE_ACTIONS.join(", ")}.` };
  }
  const out: Record<string, unknown> = { action };
  if (args.confirm === true) out.confirm = true;
  if (action === "open") {
    const url = typeof args.url === "string" ? args.url.trim() : "";
    if (!url) return { error: "browse open requires a url." };
    if (url.length > MAX_URL_CHARS) return { error: "The url is too long." };
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { error: "The url is not valid." };
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { error: "browse only opens http and https URLs." };
    }
    out.url = parsed.toString();
  }
  const selector = typeof args.selector === "string" ? args.selector.trim() : "";
  if (selector.length > MAX_SELECTOR_CHARS) return { error: "The selector is too long." };
  if ((action === "click" || action === "type") && !selector) {
    return { error: `browse ${action} requires a selector.` };
  }
  if (selector && action !== "open" && action !== "screenshot") out.selector = selector;
  if (action === "type") {
    if (typeof args.text !== "string") return { error: "browse type requires text." };
    if (args.text.length > MAX_TYPE_CHARS) return { error: "The text is too long." };
    out.text = args.text;
  }
  return { args: out };
}

function formatOutcome(
  action: BrowseAction,
  outcome: Awaited<ReturnType<BrowserDriver["perform"]>>,
  used: number,
  maxActions: number,
): ToolResult {
  const budget = { actionsUsed: used, actionsLeft: Math.max(0, maxActions - used) };
  if (!outcome.ok) {
    const hint = outcome.needsApproval
      ? " Nothing was submitted. To go ahead, call browse again with the same arguments and confirm: true; the user approves it first."
      : "";
    return { content: `${outcome.error}${hint}`, isError: true };
  }
  const { screenshot, ...rest } = outcome;
  const body: Record<string, unknown> = { action, ...rest, ...budget };
  delete body.ok;
  if (screenshot) {
    // The image stays in the sandbox workspace. The model gets its path and digest.
    const { base64: _base64, ...meta } = screenshot;
    body.screenshot = meta;
  }
  return { content: JSON.stringify(body, null, 2) };
}
