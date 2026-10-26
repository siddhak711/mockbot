"use client";

import { useState } from "react";
import { memoryPanelMode } from "../src/memory/panel-state";
import type { Memory, MemoryKind, MemoryVersion } from "../src/types";

export function MemoryPanel({
  memories,
  error,
  agentId,
  onChanged,
}: {
  memories: Memory[] | null;
  error: string | null;
  agentId: string;
  onChanged: () => Promise<void>;
}) {
  const mode = memoryPanelMode(memories, error);
  return (
    <div className="memory-panel">
      {error ? (
        <p className="error memory-error" role="alert">
          {error}{" "}
          <button type="button" className="ghost-text" onClick={() => void onChanged()}>
            Retry
          </button>
        </p>
      ) : null}
      {mode === "loading" ? (
        <div className="computer-empty">
          <h3>Loading memories</h3>
          <p>Checking what this agent has saved.</p>
        </div>
      ) : mode === "error" ? null : mode === "empty" ? (
        <div className="computer-empty">
          <h3>No memories yet</h3>
          <p>Ask Mockbot to remember a fact. It can use that fact in a later chat.</p>
        </div>
      ) : (
        <div className="memory-scroll">
          {(memories ?? []).map((memory) => (
            <MemoryCard key={memory.id} memory={memory} agentId={agentId} onChanged={onChanged} />
          ))}
        </div>
      )}
    </div>
  );
}

function memoryPath(id: string, agentId: string): string {
  return `/api/memories/${id}?agentId=${encodeURIComponent(agentId)}`;
}

function MemoryCard({
  memory,
  agentId,
  onChanged,
}: {
  memory: Memory;
  agentId: string;
  onChanged: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(memory.content);
  const [kind, setKind] = useState<MemoryKind>(memory.kind);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const content = draft.trim();
    if (!content || busy) return;
    setBusy(true);
    setError(null);
    const response = await fetch(memoryPath(memory.id, agentId), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content, kind }),
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      setError(body?.error ?? "Could not update memory");
      setBusy(false);
      return;
    }
    setEditing(false);
    setBusy(false);
    await onChanged();
  }

  async function remove() {
    if (busy) return;
    setBusy(true);
    setError(null);
    const response = await fetch(memoryPath(memory.id, agentId), { method: "DELETE" });
    if (!response.ok) {
      setError("Could not delete memory");
      setBusy(false);
      return;
    }
    await onChanged();
  }

  return (
    <article className="memory-card">
      <div className="memory-topline">
        <h3 className="memory-key">{memory.key}</h3>
        <span className="chip">{memory.kind}</span>
      </div>
      {editing ? (
        <div className="memory-edit">
          <div className="kind-toggle" role="group" aria-label="Memory kind">
            <button
              type="button"
              className={kind === "profile" ? "on" : undefined}
              onClick={() => setKind("profile")}
            >
              Profile
            </button>
            <button
              type="button"
              className={kind === "fact" ? "on" : undefined}
              onClick={() => setKind("fact")}
            >
              Fact
            </button>
          </div>
          <textarea
            aria-label={`Edit ${memory.key}`}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
        </div>
      ) : (
        <p className="memory-content">{memory.content}</p>
      )}
      <p className="memory-meta">
        {memory.createdBy === "user" ? "Saved by you" : "Saved by the agent"}
        {" · "}
        {formatWhen(memory.validFrom)}
        {memory.sourceSnippet ? ` · From you: “${memory.sourceSnippet}”` : null}
      </p>
      {error ? (
        <p className="error memory-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="memory-actions">
        {editing ? (
          <>
            <button
              type="button"
              className="ghost-text"
              onClick={() => void save()}
              disabled={busy}
            >
              Save
            </button>
            <button
              type="button"
              className="ghost-text"
              onClick={() => {
                setEditing(false);
                setDraft(memory.content);
                setKind(memory.kind);
                setError(null);
              }}
              disabled={busy}
            >
              Cancel
            </button>
          </>
        ) : (
          <button
            type="button"
            className="ghost-text"
            onClick={() => {
              setDraft(memory.content);
              setKind(memory.kind);
              setEditing(true);
            }}
            disabled={busy}
          >
            Edit
          </button>
        )}
        <button
          type="button"
          className="ghost-text danger"
          onClick={() => void remove()}
          disabled={busy}
          aria-label={`Delete memory ${memory.key}`}
        >
          Delete
        </button>
      </div>
      {memory.history.length > 0 ? (
        <details className="memory-history">
          <summary>History ({memory.history.length})</summary>
          <ul>
            {memory.history.map((version) => (
              <li key={version.id}>
                <HistoryLine version={version} />
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </article>
  );
}

function HistoryLine({ version }: { version: MemoryVersion }) {
  const when = version.deletedAt
    ? `deleted ${formatWhen(version.deletedAt)}`
    : version.validTo
      ? `until ${formatWhen(version.validTo)}`
      : formatWhen(version.validFrom);
  return (
    <>
      <span>{version.content}</span>
      <span className="memory-meta">{when}</span>
    </>
  );
}

function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
