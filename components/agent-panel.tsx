"use client";

import { useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";
import type { Agent } from "../src/agents/types";
import type { SpriteState } from "../src/sprite";
import { CloseIcon, PlusIcon } from "./icons";
import { Mochi } from "./mochi";

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
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  async function submit() {
    setPending(true);
    setError(null);
    const message = await onCreate({
      name,
      instructions,
      memoryNote,
      computerId,
      connectorId,
    });
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
          onClick={() => setOpen((value) => !value)}
          disabled={busy}
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
                if (event.target === event.currentTarget) setOpen(false);
              }}
            >
              <div
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
                    onClick={() => setOpen(false)}
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
                    New chats use the selected agent. From the lead, send{" "}
                    <code>delegate to Name: task</code>.
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
