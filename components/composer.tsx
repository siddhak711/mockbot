import { useState } from "react";

export function Composer({
  streaming,
  onSend,
  onStop,
}: {
  streaming: boolean;
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
      {streaming ? (
        <button type="button" className="stop" onClick={onStop}>
          Stop generating
        </button>
      ) : (
        <button type="submit" className="primary" disabled={!value.trim()}>
          Send
        </button>
      )}
    </form>
  );
}
