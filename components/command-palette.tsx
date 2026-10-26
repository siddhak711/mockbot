"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";

type Command = { id: string; label: string; run: () => void };

export function CommandPalette({
  open,
  onClose,
  commands,
}: {
  open: boolean;
  onClose: () => void;
  commands: Command[];
}) {
  const titleId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return commands;
    return commands.filter((command) => command.label.toLowerCase().includes(needle));
  }, [commands, query]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setIndex(0);
    const timer = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [open]);

  useEffect(() => {
    setIndex(0);
  }, [query]);

  if (!open) return null;

  return (
    <div className="command-modal">
      <div
        className="command-window"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          } else if (event.key === "ArrowDown") {
            event.preventDefault();
            setIndex((current) => Math.min(matches.length - 1, current + 1));
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setIndex((current) => Math.max(0, current - 1));
          } else if (event.key === "Enter") {
            event.preventDefault();
            matches[index]?.run();
          }
        }}
      >
        <header className="connector-head">
          <h2 id={titleId}>Commands</h2>
        </header>
        <div className="connector-body">
          <input
            ref={inputRef}
            className="command-search"
            aria-label="Command"
            placeholder="Search commands"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <div className="command-list" role="listbox">
            {matches.map((command, itemIndex) => (
              <button
                key={command.id}
                type="button"
                role="option"
                aria-selected={itemIndex === index}
                className={itemIndex === index ? "on" : undefined}
                onClick={() => command.run()}
              >
                {command.label}
              </button>
            ))}
            {matches.length === 0 ? (
              <p className="t2">No commands match “{query.trim()}”.</p>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
