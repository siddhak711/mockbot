import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { LivePhase, Message } from "../src/types";
import { ToolCallCard } from "./tool-activity";

const markdownPlugins = [remarkGfm];

export function AssistantStream({
  message,
  live,
  livePhase,
}: {
  message: Message;
  live: boolean;
  livePhase: LivePhase | null;
}) {
  const trace = message.trace;
  const answer = message.content;
  const showTextCursor = live && livePhase === "text";
  const [reasoningOpen, setReasoningOpen] = useState(true);

  return (
    <>
      {trace?.started ? (
        <div className="stream-token" aria-label="Start token" data-token="start">
          <span className="token-pill">start</span>
          <span>role {trace.role ?? "assistant"}</span>
        </div>
      ) : null}
      {trace && trace.reasoning.length > 0 ? (
        <details
          className="reasoning"
          open={reasoningOpen}
          data-reasoning="true"
          onToggle={(event) => setReasoningOpen(event.currentTarget.open)}
        >
          <summary>
            <span className="reasoning-mark" aria-hidden="true" />
            Reasoning
          </summary>
          <p
            className={
              live && livePhase === "reasoning" ? "reasoning-body streaming" : "reasoning-body"
            }
          >
            {trace.reasoning}
          </p>
        </details>
      ) : null}
      {trace && trace.tools.length > 0 ? (
        <div className="cards">
          {trace.tools.map((tool) => (
            <ToolCallCard
              key={`${tool.index}:${tool.id}`}
              tool={tool}
              pending={live && livePhase === "tool" && tool.result == null}
            />
          ))}
        </div>
      ) : null}
      {answer ? (
        <div className={showTextCursor ? "markdown streaming" : "markdown"}>
          <ReactMarkdown remarkPlugins={markdownPlugins}>{answer}</ReactMarkdown>
        </div>
      ) : showTextCursor ? (
        <div className="markdown streaming" />
      ) : null}
      {trace?.ended ? (
        <div className="stream-token end" aria-label="End token" data-token="end">
          <span className="token-pill">end</span>
          <span>finish {trace.finishReason ?? "stop"}</span>
        </div>
      ) : null}
    </>
  );
}
