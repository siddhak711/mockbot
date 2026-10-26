import type { ColorScheme } from "./theme";
import type { LivePhase, ToolCallStatus } from "./types";

export type SpriteState = "idle" | "thinking" | "working" | "done" | "error";

/** Suggested hold from the sprite spec: done, then idle. */
export const DONE_HOLD_MS = 2000;

export const SPRITE_MIN_PX = 24;

export type SpriteActivity = {
  messageId: string;
  state: ToolCallStatus;
};

export type SpriteRun = {
  streaming: boolean;
  livePhase: LivePhase | null;
  /** Chat alert text. Cleared when the next turn starts. */
  turnError: string | null;
  activities: readonly SpriteActivity[];
  /** Assistant row the live turn is writing. Null before that row exists. */
  liveMessageId: string | null;
  /** Assistant row of the latest finished turn. */
  lastMessageId: string | null;
  /**
   * Age of a successful finish. Null when no done-hold is active.
   * The caller clears this at DONE_HOLD_MS.
   */
  finishedAgoMs: number | null;
};

export function spritePixels(size: number): number {
  if (!Number.isFinite(size)) return SPRITE_MIN_PX;
  return Math.max(SPRITE_MIN_PX, Math.round(size));
}

export function spriteSrc(state: SpriteState, scheme: ColorScheme, reducedMotion: boolean): string {
  const motion = reducedMotion ? ".static" : "";
  return `/sprites/mochi/svg/mochi-${state}-${scheme}${motion}.svg`;
}

export function liveAssistantId(
  streaming: boolean,
  messages: readonly { id: string; role: string }[],
  idsBeforeTurn: ReadonlySet<string>,
): string | null {
  if (!streaming) return null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message && message.role === "assistant" && !idsBeforeTurn.has(message.id)) {
      return message.id;
    }
  }
  return null;
}

export function lastAssistantId(messages: readonly { id: string; role: string }[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "assistant") return message.id;
  }
  return null;
}

export function shouldStartDoneHold(input: {
  wasStreaming: boolean;
  streaming: boolean;
  turnError: string | null;
  toolFailed: boolean;
}): boolean {
  return input.wasStreaming && !input.streaming && !input.turnError && !input.toolFailed;
}

export type SpriteAlertKind = "turn" | "workspace";

/** A banner string, and whether it belongs to Mochi or only to the page. */
export type SpriteAlert = {
  message: string;
  kind: SpriteAlertKind;
  /** Conversation open when the alert was raised. Null is an unsaved draft. */
  ownerId: string | null;
};

/**
 * Mochi's error face is only a failed chat turn.
 * Rename, delete, and approval alerts stay on the page, and a turn error
 * does not follow the user into another conversation.
 */
export function spriteTurnErrorForView(
  alert: SpriteAlert | null,
  conversationId: string | null,
): string | null {
  if (!alert || alert.kind !== "turn") return null;
  if (alert.ownerId !== conversationId) return null;
  return alert.message;
}

export type DoneHoldKey = {
  conversationId: string | null;
  turnId: string | null;
};

/** The two-second done pose belongs to one conversation and one assistant turn. */
export function doneHoldStillApplies(hold: DoneHoldKey | null, view: DoneHoldKey): boolean {
  if (!hold) return false;
  return hold.conversationId === view.conversationId && hold.turnId === view.turnId;
}

/**
 * Map a run onto Mochi's five states.
 *
 * Covered by the sprite spec:
 * - idle when nothing is running
 * - thinking while the model is reasoning
 * - working while a tool is running
 * - done for DONE_HOLD_MS after a successful finish
 * - error when the turn or a tool on that turn failed
 *
 * Calls the spec does not name are documented on the pull request.
 */
export function spriteStateForRun(run: SpriteRun): SpriteState {
  const scoped = activitiesForRun(run);
  const toolFailed = scoped.some((activity) => activity.state === "error");
  const toolRunning = scoped.some((activity) => activity.state === "running");
  const approvalPending = scoped.some((activity) => activity.state === "approval");

  if (run.turnError || toolFailed) return "error";
  if (run.streaming && toolRunning) return "working";
  if (run.streaming && run.livePhase === "tool" && !approvalPending) return "working";
  if (run.streaming) return "thinking";
  if (run.finishedAgoMs !== null && run.finishedAgoMs >= 0 && run.finishedAgoMs < DONE_HOLD_MS) {
    return "done";
  }
  return "idle";
}

function activitiesForRun(run: SpriteRun): readonly SpriteActivity[] {
  if (run.streaming) {
    if (!run.liveMessageId) return [];
    return run.activities.filter((activity) => activity.messageId === run.liveMessageId);
  }
  if (!run.lastMessageId) return [];
  return run.activities.filter((activity) => activity.messageId === run.lastMessageId);
}

export function spriteLabel(state: SpriteState): string {
  if (state === "idle") return "ready";
  if (state === "thinking") return "thinking";
  if (state === "working") return "working";
  if (state === "done") return "done";
  return "something went wrong";
}
