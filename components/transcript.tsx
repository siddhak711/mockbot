import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { activityStaysInChat } from "../src/chat-activities";
import { isPinnedToBottom } from "../src/chat-scroll";
import { DEFAULT_SPRITE_COLOR, type SpriteColor, type SpriteState } from "../src/sprite";
import { showThinkingRow } from "../src/token-stream";
import type { LivePhase, Message } from "../src/types";
import type { ToolActivity } from "../src/tools/display";
import { AssistantStream } from "./assistant-stream";
import { DownIcon } from "./icons";
import { BotSprite, botSpriteLabel } from "./bot-sprite";
import { ToolActivityCards } from "./tool-activity";

/** The in-flight assistant is the last assistant after the latest user message. */
export function liveAssistantId(messages: readonly Message[], streaming: boolean): string | null {
  if (!streaming) return null;
  let lastUser = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      lastUser = index;
      break;
    }
  }
  for (let index = messages.length - 1; index > lastUser; index -= 1) {
    const message = messages[index];
    if (message?.role === "assistant") return message.id;
  }
  return null;
}

/** True when the assistant article would paint text, an approval, or a reconnect. */
export function assistantHasVisibleBody(
  message: Message,
  activities: readonly ToolActivity[] = [],
  reconnectFor?: (activity: ToolActivity) => string | null,
): boolean {
  if (message.content.trim().length > 0) return true;
  return activities.some(
    (activity) =>
      activity.messageId === message.id &&
      activityStaysInChat(activity, reconnectFor?.(activity) ?? null),
  );
}

export function Transcript({
  messages,
  streaming = false,
  livePhase = null,
  activities = [],
  decidingId,
  onDecide,
  onAnswer,
  onSelectTool,
  onOpenTrace,
  spriteState = "idle",
  spriteColor = DEFAULT_SPRITE_COLOR,
  spriteName = "Mockbot",
  reconnectFor,
  onReconnect,
}: {
  messages: Message[];
  streaming?: boolean;
  livePhase?: LivePhase | null;
  spriteState?: SpriteState;
  spriteColor?: SpriteColor;
  spriteName?: string;
  activities?: ToolActivity[];
  decidingId?: string | null;
  onDecide?: (id: string, decision: "approve" | "deny") => void;
  onAnswer?: (id: string, answer: string) => void;
  onSelectTool?: (id: string) => void;
  onOpenTrace?: () => void;
  reconnectFor?: (activity: ToolActivity) => string | null;
  onReconnect?: (activity: ToolActivity) => void;
}) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const wasStreaming = useRef(streaming);
  const anchorRef = useRef(messages[0]?.id ?? "");
  const [pinned, setPinned] = useState(true);
  const liveId = liveAssistantId(messages, streaming);
  const liveMessage = liveId ? messages.find((message) => message.id === liveId) : null;
  const pendingThink =
    streaming && (!liveMessage || showThinkingRow(true, livePhase, Boolean(liveMessage.content)));

  const stickToBottom = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, []);

  useLayoutEffect(() => {
    const anchor = messages[0]?.id ?? "";
    const started = streaming && !wasStreaming.current;
    wasStreaming.current = streaming;
    if (anchorRef.current !== anchor || started) {
      anchorRef.current = anchor;
      pinnedRef.current = true;
      setPinned(true);
    }
    if (!pinnedRef.current) return;
    stickToBottom();
  }, [messages, streaming, livePhase, pendingThink, activities, stickToBottom]);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const onScroll = () => {
      const next = isPinnedToBottom({
        scrollTop: el.scrollTop,
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
      });
      pinnedRef.current = next;
      setPinned((current) => (current === next ? current : next));
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  const showReturn = !pinned && messages.length > 0;

  function stickAndPin() {
    pinnedRef.current = true;
    setPinned(true);
    stickToBottom();
  }

  return (
    <div className="transcript-frame">
      <div className="transcript" ref={scrollerRef} data-pinned={pinned ? "true" : "false"}>
        {messages.length === 0 ? (
          <div className="transcript-empty">
            <BotSprite
              state="idle"
              color={spriteColor}
              size={64}
              label={botSpriteLabel(spriteName, "idle")}
            />
            <h2>Start a conversation</h2>
            <p>
              Ask Mockbot to remember a fact. It can use that fact in a later chat. Replies stream
              as a clean answer. Open the Trace tab for the full raw transcript, including the
              system prompt and every tool call. Create another agent, then send{" "}
              <code>delegate to Name: task</code>.
            </p>
          </div>
        ) : (
          <div className="transcript-column">
            {messages.map((message) => {
              const live = message.id === liveId;
              if (message.role === "user") {
                return (
                  <article key={message.id} className="message user" aria-label="You">
                    <p className="user-text">{message.content}</p>
                  </article>
                );
              }
              const visibleActivities = activities.filter(
                (activity) =>
                  activity.messageId === message.id &&
                  activityStaysInChat(activity, reconnectFor?.(activity) ?? null),
              );
              if (!assistantHasVisibleBody(message, activities, reconnectFor)) {
                return null;
              }
              return (
                <article
                  key={message.id}
                  className="message assistant"
                  aria-label={live ? "Reply still streaming" : "Mockbot"}
                >
                  {visibleActivities.length > 0 ? (
                    <ToolActivityCards
                      activities={visibleActivities}
                      decidingId={decidingId}
                      onDecide={onDecide}
                      onAnswer={onAnswer}
                      onSelect={onSelectTool}
                      reconnectFor={reconnectFor}
                      onReconnect={onReconnect}
                    />
                  ) : null}
                  <AssistantStream
                    message={message}
                    live={live}
                    livePhase={live ? livePhase : null}
                    spriteState={live ? spriteState : "idle"}
                    onOpenTrace={onOpenTrace}
                    showThinking={false}
                  />
                </article>
              );
            })}
            {pendingThink ? (
              <div className="thinking" aria-live="polite" aria-label="Thinking">
                <BotSprite state={spriteState} color={spriteColor} size={32} />
                <span className="thinking-label">Thinking</span>
                <span className="thinking-shimmer" aria-hidden="true" />
                {onOpenTrace ? (
                  <button type="button" className="thinking-trace" onClick={onOpenTrace}>
                    Trace
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        )}
      </div>
      {showReturn ? (
        <button type="button" className="return-latest" onClick={stickAndPin}>
          <DownIcon />
          <span>Return to latest</span>
        </button>
      ) : null}
    </div>
  );
}
