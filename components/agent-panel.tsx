"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Agent } from "../src/agents/types";
import type { SpriteState } from "../src/sprite";
import { CloseIcon, PlusIcon } from "./icons";
import { Mochi } from "./mochi";

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusableIn(root: HTMLElement) {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.tabIndex >= 0);
}

export type AgentDraft = {
  name: string;
  instructions: string;
  memoryNote: string;
  computerId: string;
  connectorId: string;
};

export function AgentPanel({
  agents,
  activeAgentId,
  spriteState,
  busy,
  onSelect,
  onCreate,
}: {
  agents: Agent[];
  activeAgentId: string;
  spriteState: SpriteState;
  busy: boolean;
  onSelect: (id: string) => void;
  onCreate: (draft: AgentDraft) => Promise<string | null>;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [instructions, setInstructions] = useState("");
  const [memoryNote, setMemoryNote] = useState("");
  const [computerId, setComputerId] = useState("");
  const [connectorId, setConnectorId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  pendingRef.current = pending;

  function closeForm() {
    if (pendingRef.current) return;
    setOpen(false);
  }

  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const root = dialog;

    const inerted: HTMLElement[] = [];
    for (const node of document.body.children) {
      if (!(node instanceof HTMLElement) || node.contains(root) || node.inert) continue;
      node.inert = true;
      inerted.push(node);
    }

    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        closeForm();
        return;
      }
      if (event.key !== "Tab" || event.altKey || event.ctrlKey || event.metaKey) return;
      const items = focusableIn(root);
      if (items.length === 0) {
        event.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) return;
      const active = document.activeElement;
      const inside = active instanceof Node && root.contains(active);
      if (!inside) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
        return;
      }
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      for (const node of inerted) node.inert = false;
    };
  }, [open]);

  async function submit() {
    pendingRef.current = true;
    setPending(true);
    setError(null);
    const message = await onCreate({
      name,
      instructions,
      memoryNote,
      computerId,
      connectorId,
    });
    pendingRef.current = false;
    setPending(false);
    if (message) {
      setError(message);
      return;
    }
    setName("");
    setInstructions("");
    setMemoryNote("");
    setComputerId("");
    setConnectorId("");
    setOpen(false);
  }

  return (
    <section className="agent-section" aria-label="Agents">
      <div className="section-head">
        <div className="label">Agents</div>
        <button
          type="button"
          className="icon-btn"
          aria-expanded={open}
          aria-label={open ? "Close form" : "New agent"}
          onClick={() => {
            if (pendingRef.current) return;
            setOpen((value) => !value);
          }}
          disabled={busy || pending}
        >
          {open ? <CloseIcon /> : <PlusIcon />}
        </button>
      </div>
      <div className="list">
        {agents.map((agent) => {
          const selected = agent.id === activeAgentId;
          return (
            <button
              key={agent.id}
              type="button"
              className={selected ? "item on" : "item"}
              aria-current={selected ? "true" : undefined}
              onClick={() => onSelect(agent.id)}
              disabled={busy}
            >
              <Mochi state={selected ? spriteState : "idle"} size={24} />
              <span className="item-label">{agent.name}</span>
            </button>
          );
        })}
      </div>
      {open && typeof document !== "undefined"
        ? createPortal(
            <div
              className="agent-modal"
              onMouseDown={(event) => {
                if (pendingRef.current) return;
                if (event.target === event.currentTarget) closeForm();
              }}
            >
              <div
                ref={dialogRef}
                className="agent-dialog"
                role="dialog"
                aria-modal="true"
                aria-labelledby={titleId}
              >
                <header className="agent-dialog-head">
                  <h2 id={titleId}>New agent</h2>
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label="Close"
                    disabled={pending}
                    onClick={closeForm}
                  >
                    <CloseIcon />
                  </button>
                </header>
                <form
                  className="agent-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void submit();
                  }}
                >
                  <label>
                    Name
                    <input
                      aria-label="Agent name"
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      disabled={pending}
                      autoFocus
                    />
                  </label>
                  <label className="agent-instructions">
                    Instructions
                    <textarea
                      aria-label="Agent instructions"
                      value={instructions}
                      onChange={(event) => setInstructions(event.target.value)}
                      rows={6}
                      disabled={pending}
                    />
                  </label>
                  <label>
                    Memory
                    <input
                      aria-label="Agent memory"
                      value={memoryNote}
                      onChange={(event) => setMemoryNote(event.target.value)}
                      placeholder="Optional note only this agent can use"
                      disabled={pending}
                    />
                  </label>
                  <label>
                    Computer
                    <input
                      aria-label="Computer id"
                      value={computerId}
                      onChange={(event) => setComputerId(event.target.value)}
                      placeholder="Optional computer id"
                      disabled={pending}
                    />
                  </label>
                  <label>
                    Connector
                    <input
                      aria-label="Connector id"
                      value={connectorId}
                      onChange={(event) => setConnectorId(event.target.value)}
                      placeholder="Optional connector id"
                      disabled={pending}
                    />
                  </label>
                  <p className="agent-hint">
                    Selecting an agent opens that agent's conversation. From the lead, send{" "}
                    <code>delegate to Name: task</code>. The result is appended to that agent's
                    thread.
                  </p>
                  {error ? (
                    <p className="agent-error" role="alert">
                      {error}
                    </p>
                  ) : null}
                  <button type="submit" className="primary-btn" disabled={pending || busy}>
                    Create agent
                  </button>
                </form>
              </div>
            </div>,
            document.body,
          )
        : null}
    </section>
  );
}
