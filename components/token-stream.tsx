"use client";

import { useState } from "react";
import { renderRawTranscript } from "../src/raw-transcript";
import type { ToolActivity } from "../src/tools/display";
import type { Message } from "../src/types";
import { liveAssistantId } from "./transcript";

/** The live trace row is the in-flight assistant, not whichever turn was stored last. */
export function isLiveTraceTurn(
  messageId: string,
  messages: readonly Message[],
  streaming: boolean,
): boolean {
  return liveAssistantId(messages, streaming) === messageId;
}

export function TokenStreamPanel({
  messages,
  activities = [],
}: {
  messages: Message[];
  activities?: ToolActivity[];
}) {
  const text = renderRawTranscript(messages, activities);
  const [copied, setCopied] = useState(false);

  async function copyTranscript() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  if (!text) {
    return (
      <div className="raw-transcript">
        <div className="computer-empty">
          <h3>No transcript yet</h3>
          <p>The system prompt, every token, and every tool call land here in full.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="raw-transcript" aria-label="Raw transcript">
      <div className="raw-transcript-bar">
        <button type="button" className="raw-transcript-copy" onClick={() => void copyTranscript()}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="raw-transcript-body">{text}</pre>
    </div>
  );
}
