import { isAuthFailure } from "./connectors/policy";
import type { ToolActivity } from "./tools/display";

/**
 * Activities that stay in the main chat. Ordinary tool rows stay in Trace.
 * Approvals, reconnect actions, and connector auth failures stay here so the
 * person can decide, reconnect, or select the failed call.
 */
export function activityStaysInChat(
  activity: ToolActivity,
  reconnectLabel: string | null,
): boolean {
  if (activity.state === "approval" || activity.state === "ask") return true;
  if (reconnectLabel) return true;
  return activity.state === "error" && isAuthFailure(activity.output);
}
