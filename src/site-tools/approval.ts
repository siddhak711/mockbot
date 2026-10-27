import { browseNeedsApproval } from "../browser/tool";
import type { ToolContext } from "../tools/types";
import { parseSiteToolTask, slugSiteToolName } from "./parse";
import type { EmittedStep, SiteToolDeps } from "./types";

export function taskNeedsSubmitApproval(task: string): boolean {
  const parsed = parseSiteToolTask(task);
  if (!parsed.ok) return false;
  for (const step of parsed.steps) {
    if (step.op !== "click" && step.op !== "type") continue;
    if (step.selector.kind !== "literal") continue;
    if (browseNeedsApproval({ action: step.op, selector: step.selector.value })) return true;
  }
  return false;
}

/** Typed replay args that name a submit, login, or label control. */
export function argsNeedSubmitApproval(args: unknown): boolean {
  if (!args || typeof args !== "object" || Array.isArray(args)) return false;
  for (const value of Object.values(args)) {
    if (typeof value !== "string") continue;
    if (browseNeedsApproval({ action: "click", selector: value })) return true;
    if (browseNeedsApproval({ action: "type", selector: value })) return true;
  }
  return false;
}

/** A saved script whose click or type step names a submit, login, or label control. */
export function scriptNeedsSubmitApproval(script: string): boolean {
  const match = script.match(/const STEPS = (\[[\s\S]*?\]);/);
  if (!match?.[1]) return false;
  let steps: unknown;
  try {
    steps = JSON.parse(match[1]);
  } catch {
    return false;
  }
  if (!Array.isArray(steps)) return false;
  for (const step of steps) {
    if (!step || typeof step !== "object") continue;
    const record = step as EmittedStep;
    if (record.op !== "click" && record.op !== "type") continue;
    if (typeof record.selector !== "string") continue;
    if (browseNeedsApproval({ action: record.op, selector: record.selector })) return true;
  }
  return false;
}

export async function siteToolCallNeedsApproval(
  kind: "mint" | "run",
  args: Record<string, unknown>,
  context: ToolContext | undefined,
  deps: Pick<SiteToolDeps, "repository">,
): Promise<boolean> {
  if (args.confirm === true) return true;
  if (kind === "mint") {
    return taskNeedsSubmitApproval(typeof args.task === "string" ? args.task : "");
  }
  if (argsNeedSubmitApproval(args.args)) return true;
  const userId = context?.userId?.trim();
  const name = typeof args.name === "string" ? args.name.trim() : "";
  if (!userId || !name) return false;
  const record = await deps.repository.latest(userId, slugSiteToolName(name));
  if (!record) return false;
  return scriptNeedsSubmitApproval(record.script);
}
