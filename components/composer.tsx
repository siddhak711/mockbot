import { useState } from "react";

export function Composer({
  streaming,
  awaitingApproval = false,
  onSend,
  onStop,
}: {
  streaming: boolean;
  awaitingApproval?: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
}) {
  const [value, setValue] = useState("");

  function submit() {
    const text = value.trim();
    if (!text || streaming) return;
    setValue("");
    onSend(text);
  }

  return (
    <div className="dock">
      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <textarea
          aria-label="Message"
          placeholder="Message Mockbot"
          value={value}
          rows={2}
          disabled={streaming}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
        />
        <div className="composer-row">
          {streaming ? (
            <span className="hint">{awaitingApproval ? "Needs approval" : "Responding"}</span>
          ) : null}
          <span className="grow" />
          {streaming ? (
            <button type="button" className="stop" aria-label="Stop generating" onClick={onStop}>
              <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true">
                <rect x="0.5" y="0.5" width="11" height="11" rx="1.4" fill="currentColor" />
              </svg>
            </button>
          ) : (
            <button type="submit" className="send" aria-label="Send" disabled={!value.trim()}>
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                aria-hidden="true"
              >
                <path d="M12 19V5M6 11l6-6 6 6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
