import { useState } from "react";
import { PlusIcon } from "./icons";

export function canSendMessage(streaming: boolean, awaitingApproval: boolean): boolean {
  return !streaming && !awaitingApproval;
}

export function Composer({
  streaming,
  awaitingApproval = false,
  busyHint,
  onSend,
  onStop,
  placeholder = "Message Mockbot",
  value: controlledValue,
  onValueChange,
  onAddConnector,
}: {
  streaming: boolean;
  awaitingApproval?: boolean;
  busyHint?: string;
  onSend: (text: string) => void;
  onStop: () => void;
  placeholder?: string;
  value?: string;
  onValueChange?: (value: string) => void;
  onAddConnector?: () => void;
}) {
  const [internalValue, setInternalValue] = useState("");
  const [menu, setMenu] = useState(false);
  const value = controlledValue ?? internalValue;

  function setValue(next: string) {
    onValueChange?.(next);
    if (controlledValue === undefined) setInternalValue(next);
  }

  const busy = !canSendMessage(streaming, awaitingApproval);

  function submit() {
    const text = value.trim();
    if (!text || busy) return;
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
          placeholder={placeholder}
          value={value}
          rows={2}
          disabled={busy}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
        />
        <div className="composer-row">
          {onAddConnector ? (
            <div className="composer-plus">
              <button
                type="button"
                className="icon-btn"
                aria-label="Add"
                aria-expanded={menu}
                aria-haspopup="menu"
                onClick={() => setMenu((open) => !open)}
              >
                <PlusIcon />
              </button>
              {menu ? (
                <div className="menu" role="menu">
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenu(false);
                      onAddConnector();
                    }}
                  >
                    Add connector…
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}
          {busy ? (
            <span className="hint">
              {busyHint ?? (awaitingApproval ? "Needs approval" : "Responding")}
            </span>
          ) : null}
          <span className="grow" />
          {busy ? (
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
