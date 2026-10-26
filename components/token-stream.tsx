"use client";

import { useLayoutEffect, useRef } from "react";
import type { Message } from "../src/types";
import { assistantMessagesWithTrace, tokenStreamEntries } from "../src/token-stream";

export function TokenStreamPanel({
  messages,
  streaming = false,
}: {
  messages: Message[];
  streaming?: boolean;
}) {
  const assistants = assistantMessagesWithTrace(messages);

  if (assistants.length === 0) {
    return (
      <div className="token-stream-panel">
        <div className="computer-empty">
          <h3>No token stream yet</h3>
          <p>
            Start and end tokens, reasoning, and finish reasons land here. The chat stays clean
            while you work.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="token-stream-panel" aria-label="Token stream">
      <p className="token-stream-lead">
        The raw stream stays in this side panel. Open a turn to inspect it.
      </p>
      <div className="token-stream-list">
        {assistants.map((message, index) => (
          <TokenStreamTurn
            key={message.id}
            message={message}
            latest={index === assistants.length - 1}
            live={streaming && index === assistants.length - 1}
          />
        ))}
      </div>
    </div>
  );
}

function TokenStreamTurn({
  message,
  latest,
  live,
}: {
  message: Message;
  latest: boolean;
  live: boolean;
}) {
  const entries = tokenStreamEntries(message.trace, message.content);
  const detailsRef = useRef<HTMLDetailsElement>(null);

  // Leave the element uncontrolled. Opening it here stays put when `live` flips off;
  // a controlled `open={latest && streaming}` prop collapses the turn at that moment.
  useLayoutEffect(() => {
    if (latest && detailsRef.current) detailsRef.current.open = true;
  }, [latest]);

  return (
    <details ref={detailsRef} className="token-stream-turn" data-live={live ? "true" : undefined}>
      <summary>
        <span className="token-pill">{live ? "live" : "turn"}</span>
        <span className="token-stream-summary">
          {entries.map((entry) => entry.label).join(" · ") || "trace"}
        </span>
      </summary>
      <ol className="token-stream-entries">
        {entries.map((entry, entryIndex) => (
          <li key={`${entry.kind}-${entryIndex}`} data-kind={entry.kind}>
            <div className="stream-token" data-token={entry.kind}>
              <span className="token-pill">{entry.label}</span>
              {entry.detail && entry.kind !== "reasoning" ? <span>{entry.detail}</span> : null}
            </div>
            {entry.kind === "reasoning" && entry.detail ? (
              <pre className="token-stream-reasoning">{entry.detail}</pre>
            ) : null}
          </li>
        ))}
      </ol>
    </details>
  );
}
