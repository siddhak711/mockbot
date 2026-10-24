import { useEffect, useRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Message } from "../src/types";

export function Transcript({ messages }: { messages: Message[] }) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages]);

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
        {messages.map((message) => (
          <article key={message.id} className={`message ${message.role}`}>
            <div className="message-role">{message.role === "user" ? "You" : "Mockbot"}</div>
            {message.role === "assistant" ? (
              <div className="markdown">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
              </div>
            ) : (
              <p className="user-text">{message.content}</p>
            )}
          </article>
        ))}
        <div ref={endRef} />
      </div>
    </div>
  );
}
