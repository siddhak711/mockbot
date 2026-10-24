import { useEffect, useRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Message } from "../src/types";
import { ToolActivityCards, type ToolActivity } from "./tool-activity";

export function Transcript({
  messages,
  streaming = false,
  activities = [],
}: {
  messages: Message[];
  streaming?: boolean;
  activities?: ToolActivity[];
}) {
  const endRef = useRef<HTMLDivElement>(null);
  const lastAssistantId = [...messages]
    .reverse()
    .find((message) => message.role === "assistant")?.id;

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages, streaming, activities]);

  if (messages.length === 0) {
    return (
      <div className="transcript">
        <div className="transcript-empty">
          <h2>Start a conversation</h2>
          <p>Messages stream here. With no API key, Mockbot replies locally.</p>
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
          return (
            <article
              key={message.id}
              className="message assistant"
              aria-label={live ? "Reply still streaming" : "Mockbot"}
            >
              {message.id === lastAssistantId ? (
                <ToolActivityCards activities={activities} />
              ) : null}
              <div className={live ? "markdown streaming" : "markdown"}>
                {message.content ? (
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
                ) : null}
              </div>
            </article>
          );
        })}
        <div ref={endRef} />
      </div>
    </div>
  );
}
