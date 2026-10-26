import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { SpriteState } from "../src/sprite";
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
  spriteState?: SpriteState;
  onOpenTrace?: () => void;
  /** Thinking is owned by Transcript so it can cover the gap before an assistant exists. */
  showThinking?: boolean;
}) {
  const trace = message.trace;
  const answer = message.content;
  const showTextCursor = live && livePhase === "text";

  return (
    <>
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
