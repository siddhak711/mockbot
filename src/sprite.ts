import { LEAD_AGENT_ID } from "./agents/ids";
import type { LivePhase, ToolCallStatus } from "./types";

export const SPRITE_STATES = ["idle", "thinking", "working", "done", "error"] as const;
export type SpriteState = (typeof SPRITE_STATES)[number];

/** Violet is the mockbot identity. The other four are crew colors. */
export const SPRITE_COLORS = ["violet", "blue", "green", "pink", "teal"] as const;
export type SpriteColor = (typeof SPRITE_COLORS)[number];

export const DEFAULT_SPRITE_COLOR: SpriteColor = "violet";

const CREW_COLORS = ["blue", "green", "pink", "teal"] as const;

/** Suggested hold from the sprite spec: done, then idle. */
export const DONE_HOLD_MS = 2000;

/** Raster sprites stay readable at 24px. 32px is the preferred chrome size. */
export const SPRITE_MIN_PX = 24;
export const SPRITE_PREFERRED_PX = 32;

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

/**
 * Lead and the default mockbot stay violet. Every other agent keeps one crew
 * color derived from its id, so the avatar does not change between renders.
 */
export function spriteColorForAgent(
  agent: { id: string; isLead?: boolean } | null | undefined,
): SpriteColor {
  if (!agent || agent.isLead || agent.id === LEAD_AGENT_ID) return DEFAULT_SPRITE_COLOR;
  let hash = 0;
  for (let index = 0; index < agent.id.length; index += 1) {
    hash = (Math.imul(hash, 33) + agent.id.charCodeAt(index)) >>> 0;
  }
  return CREW_COLORS[hash % CREW_COLORS.length] ?? "blue";
}

export function spriteAnimSrc(color: SpriteColor, state: SpriteState): string {
  return `/sprites/crown3d/anim/${color}-${state}.webp`;
}

export function spriteStaticSrc(color: SpriteColor, state: SpriteState, scale: 1 | 2 | 3): string {
  return `/sprites/crown3d/static/${color}-${state}@${scale}x.png`;
}

/** Animated WebP, or the @1x static PNG when motion is reduced. */
export function spriteSrc(
  state: SpriteState,
  color: SpriteColor = DEFAULT_SPRITE_COLOR,
  reducedMotion = false,
): string {
  if (reducedMotion) return spriteStaticSrc(color, state, 1);
  return spriteAnimSrc(color, state);
}

/** @1x/@2x/@3x candidates. Only the static PNGs have a reduced-motion file. */
export function spriteSrcSet(
  state: SpriteState,
  color: SpriteColor = DEFAULT_SPRITE_COLOR,
  reducedMotion = false,
): string | undefined {
  if (!reducedMotion) return undefined;
  return [1, 2, 3]
    .map((scale) => `${spriteStaticSrc(color, state, scale as 1 | 2 | 3)} ${scale}x`)
    .join(", ");
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

/** A banner string, and whether it belongs to the bot sprite or only to the page. */
export type SpriteAlert = {
  message: string;
  kind: SpriteAlertKind;
  /** Conversation open when the alert was raised. Null is an unsaved draft. */
  ownerId: string | null;
};

/**
 * The bot's error face is only a failed chat turn.
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

/**
 * Leaving a conversation drops rename, delete, and approval alerts.
 * A failed turn stays stored, and the open chat decides whether it shows.
 */
export function alertAfterConversationSwitch(alert: SpriteAlert | null): SpriteAlert | null {
  if (!alert || alert.kind === "workspace") return null;
  return alert;
}

/** Banner text for the conversation on screen. A turn error stays with its owner. */
export function alertMessageForView(
  alert: SpriteAlert | null,
  conversationId: string | null,
): string | null {
  if (!alert) return null;
  if (alert.kind === "workspace") return alert.message;
  return spriteTurnErrorForView(alert, conversationId);
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
 * Map a run onto the crown bot's five states.
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
  const approvalPending = scoped.some(
    (activity) => activity.state === "approval" || activity.state === "ask",
  );

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
