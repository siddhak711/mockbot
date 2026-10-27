"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { isLeadAgent } from "../src/agents/ids";
import type { Agent } from "../src/agents/types";
import { spriteColorForAgent, type SpriteState } from "../src/sprite";
import { BotSprite } from "./bot-sprite";
import { CloseIcon } from "./icons";

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

const SEEN_KEY = "mockbot.agent-seen";

function readSeen(): Record<string, string> | null {
  try {
    const raw = window.localStorage.getItem(SEEN_KEY);
    return raw ? (JSON.parse(raw) as Record<string, string>) : null;
  } catch {
    return null;
  }
}

function writeSeen(seen: Record<string, string>) {
  try {
    window.localStorage.setItem(SEEN_KEY, JSON.stringify(seen));
  } catch {
    // Unread dots are a convenience. A blocked store only means no dots.
  }
}

/**
 * Agents whose newest reply arrived after this browser last opened them.
 * The first visit marks every thread as seen, so old replies never light up.
 */
function useUnread(agents: Agent[], activeAgentId: string): Set<string> {
  const [seen, setSeen] = useState<Record<string, string> | null>(null);

  useEffect(() => {
    if (agents.length === 0) return;
    setSeen((current) => {
      const base = current ?? readSeen();
      const next: Record<string, string> = { ...base };
      let changed = base === null;
      for (const agent of agents) {
        const at = agent.lastMessageAt;
        if (!at) continue;
        const firstVisit = base === null;
        const isActive = agent.id === activeAgentId;
        if ((firstVisit || isActive) && next[agent.id] !== at) {
          next[agent.id] = at;
          changed = true;
        }
      }
      if (!changed) return current ?? base;
      writeSeen(next);
      return next;
    });
  }, [agents, activeAgentId]);

  return useMemo(() => {
    const unread = new Set<string>();
    if (!seen) return unread;
    for (const agent of agents) {
      if (agent.id === activeAgentId || agent.lastMessageRole !== "assistant") continue;
      const at = agent.lastMessageAt;
      if (at && (!seen[agent.id] || seen[agent.id]! < at)) unread.add(agent.id);
    }
    return unread;
  }, [agents, activeAgentId, seen]);
}

function newestFirst(a: Agent, b: Agent): number {
  const left = a.lastMessageAt ?? a.createdAt;
  const right = b.lastMessageAt ?? b.createdAt;
  return right.localeCompare(left);
}

export function AgentPanel({
  agents,
  activeAgentId,
  spriteState,
  busy,
  query = "",
  formOpen,
  onFormOpenChange,
  onSelect,
  onCreate,
}: {
  agents: Agent[];
  activeAgentId: string;
  spriteState: SpriteState;
  busy: boolean;
  query?: string;
  formOpen: boolean;
  onFormOpenChange: (open: boolean) => void;
  onSelect: (id: string) => void;
  onCreate: (draft: AgentDraft) => Promise<string | null>;
}) {
  const open = formOpen;
  const setOpen = onFormOpenChange;
  const unread = useUnread(agents, activeAgentId);
  const needle = query.trim().toLowerCase();
  const matches = (agent: Agent) =>
    !needle ||
    agent.name.toLowerCase().includes(needle) ||
    (agent.preview ?? "").toLowerCase().includes(needle);
  const pinned = agents.filter((agent) => isLeadAgent(agent) && matches(agent));
  const rows = agents.filter((agent) => !isLeadAgent(agent) && matches(agent)).sort(newestFirst);
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
      {pinned.length > 0 ? (
        <div className="roster-pins">
          {pinned.map((agent) => {
            const selected = agent.id === activeAgentId;
            return (
              <button
                key={agent.id}
                type="button"
                className={selected ? "roster-pin on" : "roster-pin"}
                aria-current={selected ? "true" : undefined}
                onClick={() => onSelect(agent.id)}
                disabled={busy}
              >
                <BotSprite
                  state={selected ? spriteState : "idle"}
                  color={spriteColorForAgent(agent)}
                  size={56}
                />
                <span className="roster-pin-name">{agent.name}</span>
              </button>
            );
          })}
        </div>
      ) : null}
      <div className="roster">
        {rows.map((agent) => {
          const selected = agent.id === activeAgentId;
          const fresh = unread.has(agent.id);
          return (
            <button
              key={agent.id}
              type="button"
              className={selected ? "roster-row on" : "roster-row"}
              aria-current={selected ? "true" : undefined}
              aria-label={fresh ? `${agent.name}, new reply` : undefined}
              onClick={() => onSelect(agent.id)}
              disabled={busy}
            >
              <BotSprite
                state={selected ? spriteState : "idle"}
                color={spriteColorForAgent(agent)}
                size={44}
              />
              <span className="roster-copy">
                <span className="roster-name">{agent.name}</span>
                <span className="roster-preview">{agent.preview || "Message"}</span>
              </span>
              {fresh ? <span className="roster-dot" aria-hidden="true" /> : null}
            </button>
          );
        })}
        {needle && pinned.length === 0 && rows.length === 0 ? (
          <p className="empty">No agent matches “{query.trim()}”.</p>
        ) : null}
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
