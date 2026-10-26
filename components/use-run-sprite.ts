"use client";

import { useEffect, useRef, useState } from "react";
import {
  DONE_HOLD_MS,
  lastAssistantId,
  liveAssistantId,
  shouldStartDoneHold,
  spriteStateForRun,
  type SpriteState,
} from "../src/sprite";
import type { LivePhase, ToolCallStatus } from "../src/types";

export function useRunSprite(input: {
  streaming: boolean;
  livePhase: LivePhase | null;
  error: string | null;
  messages: readonly { id: string; role: string }[];
  activities: readonly { messageId: string; state: ToolCallStatus }[];
}): SpriteState {
  const idsBeforeTurn = useRef<Set<string>>(new Set());
  const wasStreaming = useRef(false);
  const [doneHold, setDoneHold] = useState(false);

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
  const toolFailed = input.activities.some(
    (activity) => activity.state === "error" && activity.messageId === lastId,
  );

  useEffect(() => {
    if (
      shouldStartDoneHold({
        wasStreaming: wasStreaming.current,
        streaming: input.streaming,
        turnError: input.error,
        toolFailed,
      })
    ) {
      setDoneHold(true);
    }
    if (input.streaming) setDoneHold(false);
    wasStreaming.current = input.streaming;
  }, [input.streaming, input.error, toolFailed]);

  useEffect(() => {
    if (!doneHold) return;
    const timer = window.setTimeout(() => setDoneHold(false), DONE_HOLD_MS);
    return () => window.clearTimeout(timer);
  }, [doneHold]);

  return spriteStateForRun({
    streaming: input.streaming,
    livePhase: input.livePhase,
    turnError: input.error,
    activities: input.activities,
    liveMessageId: liveAssistantId(input.streaming, input.messages, idsBeforeTurn.current),
    lastMessageId: lastId,
    finishedAgoMs: doneHold ? 0 : null,
  });
}
