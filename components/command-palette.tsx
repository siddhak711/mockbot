"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";

type Command = { id: string; label: string; run: () => void };

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

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
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
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
    if (!open) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || event.altKey || event.ctrlKey || event.metaKey) return;
      const root = dialogRef.current;
      if (!root) return;
      const items = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (el) => el.tabIndex >= 0,
      );
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) {
        event.preventDefault();
        return;
      }
      const active = document.activeElement;
      const inside = active instanceof Node && root.contains(active);
      if (!inside || (event.shiftKey && active === first)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      // Give focus back to what opened the palette, unless a command moved it elsewhere.
      const now = document.activeElement;
      const lost = !now || now === document.body || Boolean(dialogRef.current?.contains(now));
      if (lost && opener?.isConnected) opener.focus();
    };
  }, [open]);

  useEffect(() => {
    setIndex(0);
  }, [query]);

  if (!open) return null;

  return (
    <div
      className="command-modal"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="command-window"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
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
