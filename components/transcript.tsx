import { useEffect, useRef } from "react";
import type { LivePhase, Message } from "../src/types";
import type { ToolActivity } from "../src/tools/display";
import { AssistantStream } from "./assistant-stream";
import { ToolActivityCards } from "./tool-activity";

export function Transcript({
  messages,
  streaming = false,
  livePhase = null,
  activities = [],
  decidingId,
  onDecide,
  onSelectTool,
}: {
  messages: Message[];
  streaming?: boolean;
  livePhase?: LivePhase | null;
  activities?: ToolActivity[];
  decidingId?: string | null;
  onDecide?: (id: string, decision: "approve" | "deny") => void;
  onSelectTool?: (id: string) => void;
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
          <h2>Start a conversation</h2>
          <p>
            Replies stream in full: the start token, reasoning, the answer, and the end token. Tool
            calls show up when the model sends them.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="transcript">
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
              <AssistantStream message={message} live={live} livePhase={live ? livePhase : null} />
            </article>
          );
        })}
        <div ref={endRef} />
      </div>
    </div>
  );
}
