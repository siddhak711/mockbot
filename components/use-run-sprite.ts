"use client";

import { useEffect, useRef, useState } from "react";
import {
  DONE_HOLD_MS,
  doneHoldStillApplies,
  lastAssistantId,
  liveAssistantId,
  shouldStartDoneHold,
  spriteStateForRun,
  spriteTurnErrorForView,
  type DoneHoldKey,
  type SpriteAlert,
  type SpriteState,
} from "../src/sprite";
import type { LivePhase, ToolCallStatus } from "../src/types";

export function useRunSprite(input: {
  conversationId: string | null;
  streaming: boolean;
  livePhase: LivePhase | null;
  alert: SpriteAlert | null;
  messages: readonly { id: string; role: string }[];
  activities: readonly { messageId: string; state: ToolCallStatus }[];
}): SpriteState {
  const idsBeforeTurn = useRef<Set<string>>(new Set());
  const wasStreaming = useRef(false);
  const [doneHold, setDoneHold] = useState<DoneHoldKey | null>(null);

  useEffect(() => {
    if (!input.streaming) {
      idsBeforeTurn.current = new Set(
        input.messages
          .filter((message) => message.role === "assistant")
          .map((message) => message.id),
      );
    }
  }, [input.streaming, input.messages]);

  const lastId = lastAssistantId(input.messages);
  const turnError = spriteTurnErrorForView(input.alert, input.conversationId);
  const toolFailed = input.activities.some(
    (activity) => activity.state === "error" && activity.messageId === lastId,
  );
  const view: DoneHoldKey = { conversationId: input.conversationId, turnId: lastId };
  const holdActive = doneHoldStillApplies(doneHold, view);

  useEffect(() => {
    if (
      shouldStartDoneHold({
        wasStreaming: wasStreaming.current,
        streaming: input.streaming,
        turnError,
        toolFailed,
      })
    ) {
      setDoneHold({ conversationId: input.conversationId, turnId: lastId });
    } else if (input.streaming) {
      setDoneHold(null);
    }
    wasStreaming.current = input.streaming;
  }, [input.streaming, input.conversationId, lastId, turnError, toolFailed]);

  useEffect(() => {
    if (
      doneHold &&
      !doneHoldStillApplies(doneHold, {
        conversationId: input.conversationId,
        turnId: lastId,
      })
    ) {
      setDoneHold(null);
    }
  }, [doneHold, input.conversationId, lastId]);

  useEffect(() => {
    if (!holdActive) return;
    const timer = window.setTimeout(() => setDoneHold(null), DONE_HOLD_MS);
    return () => window.clearTimeout(timer);
  }, [holdActive]);

  return spriteStateForRun({
    streaming: input.streaming,
    livePhase: input.livePhase,
    turnError,
    activities: input.activities,
    liveMessageId: liveAssistantId(input.streaming, input.messages, idsBeforeTurn.current),
    lastMessageId: lastId,
    finishedAgoMs: holdActive ? 0 : null,
  });
}
