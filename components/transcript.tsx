import { useEffect, useRef } from "react";
import type { SpriteState } from "../src/sprite";
import { showThinkingRow } from "../src/token-stream";
import type { LivePhase, Message } from "../src/types";
import type { ToolActivity } from "../src/tools/display";
import { AssistantStream } from "./assistant-stream";
import { Mochi } from "./mochi";
import { ToolActivityCards } from "./tool-activity";

/** The in-flight assistant is the last assistant after the latest user message. */
export function liveAssistantId(
  messages: readonly Message[],
  streaming: boolean,
): string | null {
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

/** True when the assistant article would paint something besides an empty shell. */
export function assistantHasVisibleBody(
  message: Message,
  activities: readonly ToolActivity[] = [],
): boolean {
  if (message.content.trim().length > 0) return true;
  if (message.trace && message.trace.tools.length > 0) return true;
  return activities.some((activity) => activity.messageId === message.id);
}

export function Transcript({
  messages,
  streaming = false,
  livePhase = null,
  activities = [],
  decidingId,
  onDecide,
  onSelectTool,
  onOpenTrace,
  spriteState = "idle",
}: {
  messages: Message[];
  streaming?: boolean;
  livePhase?: LivePhase | null;
  spriteState?: SpriteState;
  activities?: ToolActivity[];
  decidingId?: string | null;
  onDecide?: (id: string, decision: "approve" | "deny") => void;
  onSelectTool?: (id: string) => void;
  onOpenTrace?: () => void;
}) {
  const endRef = useRef<HTMLDivElement>(null);
  const liveId = liveAssistantId(messages, streaming);
  const liveMessage = liveId ? messages.find((message) => message.id === liveId) : null;
  const pendingThink =
    streaming &&
    (!liveMessage || showThinkingRow(true, livePhase, Boolean(liveMessage.content)));

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages, streaming, activities, livePhase, pendingThink]);

  if (messages.length === 0) {
    return (
      <div className="transcript">
        <div className="transcript-empty">
          <Mochi state="idle" size={64} label="Mochi, ready" />
          <h2>Start a conversation</h2>
          <p>
            Ask Mockbot to remember a fact. It can use that fact in a later chat. Replies stream as a
            clean answer; open the Trace tab for start/end tokens and reasoning. Tool calls show up
            when the model sends them. Create another agent, then send{" "}
            <code>delegate to Name: task</code>.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="transcript">
      <div className="transcript-layout">
        <aside className="token-rail" aria-label="Token stream shortcuts">
          <button type="button" className="token-rail-btn" onClick={onOpenTrace} disabled={!onOpenTrace}>
            Trace
          </button>
        </aside>
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
            const messageActivities = activities.filter(
              (activity) => activity.messageId === message.id,
            );
            // Keep thinking anchored: skip hollow live shells until tools/text arrive.
            if (live && pendingThink && !assistantHasVisibleBody(message, messageActivities)) {
              return null;
            }
            return (
              <article
                key={message.id}
                className="message assistant"
                aria-label={live ? "Reply still streaming" : "Mockbot"}
              >
                <ToolActivityCards
                  activities={messageActivities}
                  decidingId={decidingId}
                  onDecide={onDecide}
                  onSelect={onSelectTool}
                />
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
              <Mochi state={spriteState} size={24} />
              <span className="thinking-label">Thinking</span>
              <span className="thinking-shimmer" aria-hidden="true" />
              {onOpenTrace ? (
                <button type="button" className="thinking-trace" onClick={onOpenTrace}>
                  Trace
                </button>
              ) : null}
            </div>
          ) : null}
          <div ref={endRef} />
        </div>
        <aside className="token-rail" aria-label="Token stream shortcuts">
          <button type="button" className="token-rail-btn" onClick={onOpenTrace} disabled={!onOpenTrace}>
            Trace
          </button>
        </aside>
      </div>
    </div>
  );
}
