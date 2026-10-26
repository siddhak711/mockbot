import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { SpriteState } from "../src/sprite";
import type { LivePhase, Message } from "../src/types";

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
  const answer = message.content;
  const showTextCursor = live && livePhase === "text";

  return (
    <>
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
