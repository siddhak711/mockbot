import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { SpriteState } from "../src/sprite";
import { showThinkingRow } from "../src/token-stream";
import type { LivePhase, Message } from "../src/types";
import { Mochi } from "./mochi";
import { ToolCallCard } from "./tool-activity";

const markdownPlugins = [remarkGfm];

export function AssistantStream({
  message,
  live,
  livePhase,
  spriteState = "idle",
  onOpenTrace,
}: {
  message: Message;
  live: boolean;
  livePhase: LivePhase | null;
  spriteState?: SpriteState;
  onOpenTrace?: () => void;
}) {
  const trace = message.trace;
  const answer = message.content;
  const showTextCursor = live && livePhase === "text";
  const thinking = showThinkingRow(live, livePhase, Boolean(answer));

  return (
    <>
      {thinking ? (
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
    </>
  );
}
