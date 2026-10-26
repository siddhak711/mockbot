import { useEffect, useRef } from "react";
import type { SpriteState } from "../src/sprite";
import type { LivePhase, Message } from "../src/types";
import type { ToolActivity } from "../src/tools/display";
import { AssistantStream } from "./assistant-stream";
import { Mochi } from "./mochi";
import { ToolActivityCards } from "./tool-activity";

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
  const lastAssistantId = [...messages]
    .reverse()
    .find((message) => message.role === "assistant")?.id;

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages, streaming, activities, livePhase]);

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
            const live = streaming && message.id === lastAssistantId;
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
                />
              </article>
            );
          })}
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
