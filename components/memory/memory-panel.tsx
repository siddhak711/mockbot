"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import type { Memory, MemoryProposal } from "../../src/types";
import { keyFromFact } from "../../src/memory/prompt";
import {
  ADD_SCOPES,
  factCount,
  factCountLabel,
  FLASH_MS,
  forgetCopy,
  forgetDecision,
  formatMemoryTooltip,
  formatMemoryWhen,
  filterMemories,
  GROUP_ORDER,
  groupLabel,
  journalDate,
  memoriesToJson,
  memoriesToMarkdown,
  memoryScope,
  SCOPE_TABS,
  SEARCH_DEBOUNCE_MS,
  SKELETON_DELAY_MS,
  sharedIds,
  sourceLabel,
  splitHighlight,
  type MemoryScope,
  type ScopeTab,
} from "../../src/memory/panel-logic";
import {
  getMemoryPanelState,
  hiddenMemoryIds,
  hydrateMemoryPanel,
  patchMemoryPanel,
  queueMemoryUndo,
  removeMemories,
  removeProposal,
  replaceProposal,
  undoLatestMemory,
  undoMemory,
  upsertMemory,
  useMemoryPanel,
} from "../../src/memory/panel-store";
import { BotSprite } from "../bot-sprite";
import { CloseIcon, PencilIcon, TrashIcon } from "../icons";
import "./memory.css";

export function MemoryUpdateChip({ label, onView }: { label: string; onView: () => void }) {
  return (
    <div className="memory-update-chip" role="status">
      <span>Memory updated · {label}</span>
      <button type="button" onClick={onView}>
        View
      </button>
    </div>
  );
}

export function MemoryPanel({
  variant = "pane",
  agentId,
  agentName = "Mockbot",
  memories: memoriesProp,
  proposals: proposalsProp,
  error: errorProp,
  onChanged,
  onClose,
  hotkeys = false,
}: {
  variant?: "pane" | "page";
  agentId: string;
  agentName?: string;
  memories?: Memory[] | null;
  proposals?: MemoryProposal[];
  error?: string | null;
  onChanged?: () => Promise<void>;
  onClose?: () => void;
  hotkeys?: boolean;
}) {
  const store = useMemoryPanel();
  const memories = memoriesProp !== undefined ? memoriesProp : store.memories;
  const proposals = proposalsProp !== undefined ? proposalsProp : store.proposals;
  const error = errorProp !== undefined ? errorProp : store.error;
  const hidden = hiddenMemoryIds(store);
  const visible = (memories ?? []).filter((memory) => !hidden.has(memory.id));
  const [draft, setDraft] = useState(store.query);
  const [adding, setAdding] = useState(false);
  const [addKey, setAddKey] = useState("");
  const [addValue, setAddValue] = useState("");
  const [addScope, setAddScope] = useState<Exclude<MemoryScope, "journal">>("profile");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [confirming, setConfirming] = useState<Memory | null>(null);
  const [bulkIds, setBulkIds] = useState<string[]>([]);
  const [bulkConfirm, setBulkConfirm] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [evidenceId, setEvidenceId] = useState<string | null>(null);
  const [showSkeleton, setShowSkeleton] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const searchRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLElement>(null);
  const titleId = useId();
  const loading = memories == null && !error;
  const failed = Boolean(error) && (memories == null || memories.length === 0);
  const filtered = filterMemories(visible, store.tab, store.query);
  const searching = store.query.trim().length > 0;
  const showPending = !searching && (store.tab === "all" || store.tab === "profile");

  useEffect(() => {
    hydrateMemoryPanel();
  }, []);

  useEffect(() => {
    setDraft(store.query);
  }, [store.query]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (getMemoryPanelState().query !== draft) patchMemoryPanel({ query: draft });
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [draft]);

  useEffect(() => {
    if (!loading) {
      setShowSkeleton(false);
      return;
    }
    const timer = window.setTimeout(() => setShowSkeleton(true), SKELETON_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [loading]);

  useEffect(() => {
    if (!store.flashId) return;
    const node = rootRef.current?.querySelector(`[data-memory-id="${CSS.escape(store.flashId)}"]`);
    node?.scrollIntoView({ block: "center" });
    const timer = window.setTimeout(() => patchMemoryPanel({ flashId: null }), FLASH_MS);
    return () => window.clearTimeout(timer);
  }, [store.flashId]);

  useEffect(() => {
    if (store.undos.length === 0) return;
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [store.undos.length]);

  useEffect(() => {
    if (!hotkeys) return;
    function onKey(event: globalThis.KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const typing = Boolean(
        target &&
        typeof target.closest === "function" &&
        target.closest("input, textarea, select, [contenteditable='true']"),
      );
      const meta = event.metaKey || event.ctrlKey;
      if (meta && event.key.toLowerCase() === "z" && !event.shiftKey) {
        const undone = undoLatestMemory();
        if (!undone) return;
        event.preventDefault();
        if (undone.action === "save") void revertSave(undone.memoryIds, undone.proposal);
        return;
      }
      if (meta && event.key.toLowerCase() === "f") {
        event.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (typing || confirming || bulkConfirm) return;
      if (event.key === "/" && !meta) {
        event.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (event.key === "Escape") {
        if (adding || editingId) {
          event.preventDefault();
          event.stopPropagation();
          setAdding(false);
          setEditingId(null);
          return;
        }
        if (variant === "pane") {
          event.preventDefault();
          onClose?.();
        }
        return;
      }
      const rows = filtered;
      const index = rows.findIndex((memory) => memory.id === store.selectedId);
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        if (rows.length === 0) return;
        event.preventDefault();
        const next =
          event.key === "ArrowDown"
            ? rows[Math.min(rows.length - 1, index + 1)]
            : rows[Math.max(0, index < 0 ? 0 : index - 1)];
        if (next) patchMemoryPanel({ selectedId: next.id });
        return;
      }
      const current = rows[index];
      if (!current) return;
      if (event.key.toLowerCase() === "e" && !meta) {
        event.preventDefault();
        beginEdit(current);
      }
      if (event.key === "Backspace" || event.key === "Delete") {
        event.preventDefault();
        askForget(current, false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  function beginEdit(memory: Memory) {
    if (memory.kind === "journal") return;
    setEditingId(memory.id);
    setEditValue(memory.content);
    patchMemoryPanel({ selectedId: memory.id });
  }

  function askForget(memory: Memory, shiftKey: boolean) {
    const decision = forgetDecision(memory.kind, shiftKey);
    if (decision === "blocked") return;
    patchMemoryPanel({ selectedId: memory.id });
    if (decision === "confirm") setConfirming(memory);
    else queueForget([memory]);
  }

  function queueForget(rows: Memory[]) {
    const hiddenIds = rows.flatMap((memory) =>
      memory.kind === "shared" ? sharedIds(visible, memory.key) : [memory.id],
    );
    queueMemoryUndo(
      {
        id: crypto.randomUUID(),
        label:
          rows.length === 1 ? `Forgot "${rows[0]?.key ?? "fact"}"` : `Forgot ${rows.length} facts`,
        key: rows[0]?.key ?? "fact",
        action: "forget",
        hiddenIds,
        memoryIds: rows.map((memory) => memory.id),
        proposal: null,
      },
      (undo) => {
        removeMemories(undo.hiddenIds);
        void commitDeletes(undo.memoryIds);
      },
    );
    setConfirming(null);
    setBulkConfirm(false);
    setBulkIds([]);
  }

  async function commitDeletes(ids: string[]) {
    await Promise.all(
      ids.map((id) => fetch(memoryPath(agentId, id), { method: "DELETE" }).catch(() => undefined)),
    );
    await onChanged?.();
  }

  async function revertSave(ids: string[], proposal: MemoryProposal | null) {
    removeMemories(ids);
    if (proposal) replaceProposal(proposal);
    await Promise.all(
      ids.map((id) => fetch(memoryPath(agentId, id), { method: "DELETE" }).catch(() => undefined)),
    );
    if (proposal) {
      await fetch(`/api/memories/proposals?agentId=${encodeURIComponent(agentId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(proposal),
      }).catch(() => undefined);
    }
    await onChanged?.();
  }

  async function saveEdit(memory: Memory) {
    const content = editValue.trim();
    if (!content) return;
    const response = await fetch(memoryPath(agentId, memory.id), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content, edited: true }),
    });
    if (!response.ok) return;
    const body = (await response.json()) as { memory: Memory };
    upsertMemory({ ...memory, ...body.memory, history: body.memory.history ?? memory.history });
    setEditingId(null);
    patchMemoryPanel({ flashId: body.memory.id, selectedId: body.memory.id });
    await onChanged?.();
  }

  async function addFact(event?: FormEvent) {
    event?.preventDefault();
    const content = addValue.trim();
    if (!content) return;
    const response = await fetch(memoryPath(agentId), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content,
        key: addKey.trim() || keyFromFact(content),
        kind: addScope,
        fromAgent: agentName,
      }),
    });
    if (!response.ok) return;
    const body = (await response.json()) as { memory: Memory };
    const memory = { ...body.memory, history: body.memory.history ?? [] };
    upsertMemory(memory);
    setAdding(false);
    setAddKey("");
    setAddValue("");
    patchMemoryPanel({ flashId: memory.id, selectedId: memory.id, tab: "all", query: "" });
    await onChanged?.();
  }

  async function approve(proposal: MemoryProposal) {
    const response = await fetch(
      `/api/memories/proposals/${proposal.id}?agentId=${encodeURIComponent(agentId)}`,
      { method: "POST" },
    );
    if (!response.ok) return;
    const body = (await response.json()) as { memory: Memory };
    const memory = { ...body.memory, history: [] };
    removeProposal(proposal.id);
    upsertMemory(memory);
    queueMemoryUndo(
      {
        id: crypto.randomUUID(),
        label: `Saved "${memory.key}"`,
        key: memory.key,
        action: "save",
        hiddenIds: [],
        memoryIds: [memory.id],
        proposal,
      },
      () => undefined,
    );
    patchMemoryPanel({ flashId: memory.id, selectedId: memory.id });
    await onChanged?.();
  }

  async function dismiss(proposal: MemoryProposal) {
    const response = await fetch(
      `/api/memories/proposals/${proposal.id}?agentId=${encodeURIComponent(agentId)}&action=dismiss`,
      { method: "POST" },
    );
    if (!response.ok) return;
    removeProposal(proposal.id);
    await onChanged?.();
  }

  function download(kind: "json" | "markdown") {
    const selected =
      bulkIds.length > 0 ? visible.filter((memory) => bulkIds.includes(memory.id)) : visible;
    const text = kind === "json" ? memoriesToJson(selected) : memoriesToMarkdown(selected);
    const blob = new Blob([text], { type: kind === "json" ? "application/json" : "text/markdown" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = kind === "json" ? "memory.json" : "memory.md";
    anchor.click();
    URL.revokeObjectURL(url);
    setExportOpen(false);
  }

  const sprite = failed ? "error" : loading ? "thinking" : "idle";
  const count = factCountLabel(factCount(visible));
  const latestUndo = store.undos[store.undos.length - 1];

  const body = (
    <>
      {variant === "pane" ? (
        <header className="memory-header">
          <BotSprite state={sprite} size={24} />
          <h2 id={titleId}>Memory</h2>
          <span className="memory-count">{count}</span>
          <div className="memory-header-actions">
            <Link
              className="memory-link"
              href="/settings/memory"
              onClick={() => rememberSettingsReturn(agentId)}
            >
              Open in Settings
              <ExternalIcon />
            </Link>
            <button type="button" className="memory-btn secondary" onClick={() => openAdd("")}>
              + Add
            </button>
            {onClose ? (
              <button
                type="button"
                className="memory-icon-btn"
                aria-label="Close"
                onClick={onClose}
              >
                <CloseIcon />
              </button>
            ) : null}
          </div>
        </header>
      ) : (
        <div className="memory-page-head">
          <BotSprite state={sprite} size={40} />
          <div>
            <h2 className="memory-page-title" id={titleId}>
              Memory
            </h2>
            <p className="memory-page-sub">What mockbot remembers about you, across every chat.</p>
          </div>
          <div className="memory-page-actions">
            <div className="memory-export">
              <button
                type="button"
                className="memory-btn secondary"
                aria-haspopup="menu"
                aria-expanded={exportOpen}
                onClick={() => setExportOpen((open) => !open)}
              >
                Export
              </button>
              {exportOpen ? (
                <div className="memory-menu" role="menu" aria-label="Export memory">
                  <button type="button" role="menuitem" onClick={() => download("json")}>
                    JSON
                  </button>
                  <button type="button" role="menuitem" onClick={() => download("markdown")}>
                    Markdown
                  </button>
                </div>
              ) : null}
            </div>
            <button type="button" className="memory-btn primary" onClick={() => openAdd("")}>
              + Add fact
            </button>
          </div>
        </div>
      )}
      <div className={variant === "page" ? "memory-page-tools" : undefined}>
        <label className="memory-search">
          <SearchIcon />
          <input
            ref={searchRef}
            aria-label="Search memory"
            placeholder="Search memory"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                setDraft("");
                patchMemoryPanel({ query: "" });
                searchRef.current?.blur();
              }
            }}
          />
          {draft ? null : <span className="memory-kbd">⌘F</span>}
        </label>
        <div className="memory-tabs" role="tablist" aria-label="Memory scopes">
          {SCOPE_TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={store.tab === tab.id}
              onClick={() => patchMemoryPanel({ tab: tab.id })}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>
      <div className="memory-scroll">
        {failed ? (
          <ErrorState
            message={error ?? "Couldn't load memory"}
            onRetry={() => void onChanged?.()}
          />
        ) : loading ? (
          showSkeleton ? (
            <Skeleton />
          ) : null
        ) : (
          <>
            {showPending && proposals.length > 0 ? (
              <PendingCard
                proposals={proposals}
                onApprove={(proposal) => void approve(proposal)}
                onDismiss={(proposal) => void dismiss(proposal)}
              />
            ) : null}
            {adding ? (
              <form className="memory-add" onSubmit={(event) => void addFact(event)}>
                <div className="memory-add-row">
                  <input
                    aria-label="Label (optional)"
                    placeholder="Label (optional)"
                    value={addKey}
                    onChange={(event) => setAddKey(event.target.value)}
                    autoFocus
                  />
                  <select
                    aria-label="Scope"
                    value={addScope}
                    onChange={(event) =>
                      setAddScope(event.target.value as Exclude<MemoryScope, "journal">)
                    }
                  >
                    {ADD_SCOPES.map((scope) => (
                      <option key={scope.id} value={scope.id}>
                        {scope.label}
                      </option>
                    ))}
                  </select>
                </div>
                <input
                  aria-label="Fact"
                  placeholder="Remember this"
                  value={addValue}
                  onChange={(event) => setAddValue(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.preventDefault();
                      setAdding(false);
                    }
                  }}
                />
                <div className="memory-dialog-actions">
                  <button
                    type="button"
                    className="memory-btn ghost"
                    onClick={() => setAdding(false)}
                  >
                    Cancel
                  </button>
                  <button type="submit" className="memory-btn secondary">
                    Add
                  </button>
                </div>
              </form>
            ) : null}
            {variant === "page" && bulkIds.length > 0 ? (
              <div className="memory-bulk">
                <span>{bulkIds.length} selected</span>
                <button
                  type="button"
                  className="memory-btn danger"
                  onClick={() => setBulkConfirm(true)}
                >
                  Forget
                </button>
              </div>
            ) : null}
            {filtered.length === 0 && !adding && (searching || proposals.length === 0) ? (
              searching ? (
                <button
                  type="button"
                  className="memory-fallback"
                  onClick={() => openAdd(store.query)}
                >
                  Add &apos;{store.query.trim()}&apos; as a fact
                </button>
              ) : (
                <EmptyState onAdd={() => openAdd("")} />
              )
            ) : variant === "page" ? (
              <PageColumns
                memories={filtered}
                tab={store.tab}
                searching={searching}
                query={store.query}
                selectedId={store.selectedId}
                flashId={store.flashId}
                editingId={editingId}
                editValue={editValue}
                bulkIds={bulkIds}
                evidenceId={evidenceId}
                onToggleEvidence={setEvidenceId}
                onSelect={(id) => patchMemoryPanel({ selectedId: id })}
                onToggleBulk={(id) =>
                  setBulkIds((current) =>
                    current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
                  )
                }
                onEdit={beginEdit}
                onForget={askForget}
                onEditValue={setEditValue}
                onSave={(memory) => void saveEdit(memory)}
                onCancelEdit={() => setEditingId(null)}
              />
            ) : (
              <Groups
                memories={filtered}
                query={store.query}
                selectedId={store.selectedId}
                flashId={store.flashId}
                editingId={editingId}
                editValue={editValue}
                evidenceId={evidenceId}
                onToggleEvidence={setEvidenceId}
                onSelect={(id) => patchMemoryPanel({ selectedId: id })}
                onEdit={beginEdit}
                onForget={askForget}
                onEditValue={setEditValue}
                onSave={(memory) => void saveEdit(memory)}
                onCancelEdit={() => setEditingId(null)}
              />
            )}
          </>
        )}
      </div>
      {confirming ? (
        <ForgetDialog
          value={confirming.content}
          shared={confirming.kind === "shared"}
          onCancel={() => setConfirming(null)}
          onForget={() => queueForget([confirming])}
        />
      ) : null}
      {bulkConfirm ? (
        <ForgetDialog
          value={`${bulkIds.length} facts`}
          shared={visible.some((memory) => bulkIds.includes(memory.id) && memory.kind === "shared")}
          onCancel={() => setBulkConfirm(false)}
          onForget={() => queueForget(visible.filter((memory) => bulkIds.includes(memory.id)))}
        />
      ) : null}
      {latestUndo ? (
        <div className="memory-toast" role="status">
          {latestUndo.label}
          <button type="button" onClick={() => undoToast(latestUndo.id)}>
            Undo
          </button>
          <span>{Math.max(0, Math.ceil((latestUndo.expiresAt - now) / 1000))}s</span>
        </div>
      ) : null}
    </>
  );

  function openAdd(seed: string) {
    setAdding(true);
    setAddValue(seed);
    setAddKey("");
    setAddScope("profile");
  }

  function undoToast(id: string) {
    const undone = undoMemory(id);
    if (undone?.action === "save") void revertSave(undone.memoryIds, undone.proposal);
  }

  if (variant === "pane") {
    return (
      <aside
        ref={rootRef}
        className="memory-ui memory-pane"
        role="complementary"
        aria-labelledby={titleId}
      >
        {onClose && typeof document !== "undefined"
          ? createPortal(
              <button
                type="button"
                className="memory-pane-scrim"
                aria-label="Close memory"
                onClick={onClose}
              />,
              document.body,
            )
          : null}
        {body}
      </aside>
    );
  }

  return (
    <section ref={rootRef} className="memory-ui" aria-labelledby={titleId}>
      {body}
    </section>
  );
}

function memoryPath(agentId: string, id?: string): string {
  const path = id ? `/api/memories/${id}` : "/api/memories";
  return `${path}?agentId=${encodeURIComponent(agentId)}`;
}

export function rememberSettingsReturn(agentId: string) {
  if (typeof sessionStorage === "undefined") return;
  sessionStorage.setItem("mockbot.memory.agent", agentId);
  sessionStorage.setItem(
    "mockbot.memory.return",
    window.location.pathname + window.location.search,
  );
  sessionStorage.setItem("mockbot.memory.reopen", "1");
}

function Highlight({ text, query }: { text: string; query: string }) {
  return (
    <>
      {splitHighlight(text, query).map((part, index) =>
        part.match ? <mark key={index}>{part.text}</mark> : <span key={index}>{part.text}</span>,
      )}
    </>
  );
}

function Groups(props: RowProps & { memories: Memory[] }) {
  return (
    <div role="list" aria-label="Memories">
      {GROUP_ORDER.map((scope) => {
        const rows = props.memories.filter((memory) => memoryScope(memory.kind) === scope);
        if (rows.length === 0) return null;
        return (
          <section key={scope} aria-label={groupLabel(scope)}>
            <div className="memory-group-label">
              <span>{groupLabel(scope)}</span>
              <span>{scope === "journal" ? "read-only" : rows.length}</span>
            </div>
            {rows.map((memory) => (
              <FactOrJournal key={memory.id} memory={memory} {...props} />
            ))}
          </section>
        );
      })}
    </div>
  );
}

function PageColumns(props: RowProps & { memories: Memory[]; tab: ScopeTab; searching: boolean }) {
  const leftScopes = GROUP_ORDER.filter((scope) => scope !== "journal");
  const journal = props.memories.filter((memory) => memory.kind === "journal");
  const showJournal = props.searching || props.tab === "all" || props.tab === "journal";
  return (
    <div className="memory-page-grid">
      <div>
        {leftScopes.map((scope) => {
          const rows = props.memories.filter((memory) => memoryScope(memory.kind) === scope);
          if (rows.length === 0) return null;
          return (
            <section key={scope} className="memory-card" aria-label={groupLabel(scope)}>
              <div className="memory-group-label">
                <span>{groupLabel(scope)}</span>
                <span>{rows.length}</span>
              </div>
              <div role="list">
                {rows.map((memory) => (
                  <FactOrJournal key={memory.id} memory={memory} {...props} bulk />
                ))}
              </div>
            </section>
          );
        })}
      </div>
      {showJournal ? (
        <section className="memory-card" aria-label="Journal">
          <div className="memory-group-label">
            <span>Journal</span>
            <span>read-only</span>
          </div>
          <div role="list">
            {journal.map((memory) => (
              <FactOrJournal key={memory.id} memory={memory} {...props} />
            ))}
          </div>
        </section>
      ) : (
        <div />
      )}
    </div>
  );
}

type RowProps = {
  query: string;
  selectedId: string | null;
  flashId: string | null;
  editingId: string | null;
  editValue: string;
  evidenceId: string | null;
  bulkIds?: string[];
  bulk?: boolean;
  onToggleEvidence: (id: string | null) => void;
  onSelect: (id: string) => void;
  onToggleBulk?: (id: string) => void;
  onEdit: (memory: Memory) => void;
  onForget: (memory: Memory, shiftKey: boolean) => void;
  onEditValue: (value: string) => void;
  onSave: (memory: Memory) => void;
  onCancelEdit: () => void;
};

function FactOrJournal(props: RowProps & { memory: Memory }) {
  const { memory } = props;
  if (memory.kind === "journal") {
    return (
      <div
        role="listitem"
        className="memory-journal"
        data-memory-id={memory.id}
        data-readonly="true"
      >
        <time dateTime={memory.validFrom}>{journalDate(memory.validFrom)}</time>
        <p>
          <Highlight text={memory.content} query={props.query} />
        </p>
      </div>
    );
  }
  const selected = props.selectedId === memory.id;
  const editing = props.editingId === memory.id;
  const source = sourceLabel(memory);
  return (
    <div
      role="listitem"
      className={[
        "memory-row",
        props.bulk ? "with-check" : "",
        selected ? "is-selected" : "",
        props.flashId === memory.id ? "is-flash" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      data-memory-id={memory.id}
      onClick={() => props.onSelect(memory.id)}
      onDoubleClick={() => props.onEdit(memory)}
    >
      {props.bulk ? (
        <input
          className="memory-check"
          type="checkbox"
          aria-label={`Select ${memory.key}`}
          checked={props.bulkIds?.includes(memory.id) ?? false}
          onChange={() => props.onToggleBulk?.(memory.id)}
          onClick={(event) => event.stopPropagation()}
        />
      ) : null}
      <div className="memory-key">
        <Highlight text={memory.key} query={props.query} />
      </div>
      <div className="memory-value">
        {editing ? (
          <input
            aria-label={`Edit ${memory.key} value`}
            value={props.editValue}
            autoFocus
            onChange={(event) => props.onEditValue(event.target.value)}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                props.onSave(memory);
              }
              if (event.key === "Escape") {
                event.preventDefault();
                props.onCancelEdit();
              }
            }}
          />
        ) : (
          <Highlight text={memory.content} query={props.query} />
        )}
      </div>
      <div className="memory-meta">
        {memory.origin === "inferred" && memory.evidence ? (
          <button
            type="button"
            className="memory-source is-button"
            onClick={(event) => {
              event.stopPropagation();
              props.onToggleEvidence(props.evidenceId === memory.id ? null : memory.id);
            }}
          >
            {source}
          </button>
        ) : (
          <span className="memory-source">{source}</span>
        )}
        <span title={formatMemoryTooltip(memory.validFrom)}>
          {" "}
          · {formatMemoryWhen(memory.validFrom)}
        </span>
        {props.evidenceId === memory.id && memory.evidence ? (
          <div className="memory-evidence">{memory.evidence}</div>
        ) : null}
      </div>
      <div className="memory-row-actions">
        <button
          type="button"
          aria-label={`Edit ${memory.key}`}
          onClick={(event) => {
            event.stopPropagation();
            props.onEdit(memory);
          }}
        >
          <PencilIcon />
        </button>
        <button
          type="button"
          aria-label={`Forget ${memory.key}`}
          onClick={(event) => {
            event.stopPropagation();
            props.onForget(memory, event.shiftKey);
          }}
        >
          <TrashIcon />
        </button>
      </div>
    </div>
  );
}

function PendingCard({
  proposals,
  onApprove,
  onDismiss,
}: {
  proposals: MemoryProposal[];
  onApprove: (proposal: MemoryProposal) => void;
  onDismiss: (proposal: MemoryProposal) => void;
}) {
  return (
    <section className="memory-pending" aria-label="Pending approval">
      <div className="memory-pending-label">
        <span>Pending approval</span>
        <span>{proposals.length}</span>
      </div>
      {proposals.map((proposal) => (
        <div key={proposal.id} className="memory-pending-row">
          <div>
            <div className="memory-value">{proposal.content}</div>
            <div className="memory-meta">
              <span className="memory-source">Inferred · {proposal.signal}</span>
              <span title={formatMemoryTooltip(proposal.createdAt)}>
                {" "}
                · {formatMemoryWhen(proposal.createdAt)}
              </span>
            </div>
          </div>
          <div className="memory-pending-actions">
            <button type="button" className="memory-btn ghost" onClick={() => onDismiss(proposal)}>
              Dismiss
            </button>
            <button
              type="button"
              className="memory-btn secondary"
              onClick={() => onApprove(proposal)}
            >
              ✓ Approve
            </button>
          </div>
        </div>
      ))}
    </section>
  );
}

function EmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="memory-empty">
      <BotSprite state="idle" size={72} />
      <h3>Nothing remembered yet</h3>
      <button type="button" className="memory-btn primary" onClick={onAdd}>
        + Add fact
      </button>
    </div>
  );
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="memory-error" role="alert">
      <BotSprite state="error" size={72} />
      <h3>Couldn&apos;t load memory</h3>
      <p>Nothing was lost. Check your connection.</p>
      <p className="memory-code">ERR_MEMORY_LOAD</p>
      <p className="memory-code">{message}</p>
      <button type="button" className="memory-btn secondary" onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}

function Skeleton() {
  return (
    <div aria-hidden="true">
      {Array.from({ length: 7 }, (_, index) => (
        <div key={index} className="memory-skeleton" />
      ))}
    </div>
  );
}

function ForgetDialog({
  value,
  shared,
  onCancel,
  onForget,
}: {
  value: string;
  shared: boolean;
  onCancel: () => void;
  onForget: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const focusable = () =>
      [...root.querySelectorAll<HTMLElement>("button, [href], input, select, textarea")].filter(
        (node) => !node.hasAttribute("disabled"),
      );
    focusable()[0]?.focus();
    function onKey(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCancel();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusable();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    root.addEventListener("keydown", onKey);
    return () => root.removeEventListener("keydown", onKey);
  }, [onCancel]);
  return (
    <div className="memory-scrim">
      <div
        ref={ref}
        className="memory-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <h3 id={titleId}>Forget this fact?</h3>
        <p>{forgetCopy(value, shared)}</p>
        <form
          className="memory-dialog-actions"
          onSubmit={(event) => {
            event.preventDefault();
            onForget();
          }}
        >
          <button type="button" className="memory-btn secondary" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="memory-btn danger">
            Forget
          </button>
        </form>
      </div>
    </div>
  );
}

function SearchIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      <circle cx="11" cy="11" r="6" />
      <path d="m16 16 4 4" strokeLinecap="round" />
    </svg>
  );
}

function ExternalIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d="M14 6h4v4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M18 6 10 14" strokeLinecap="round" />
      <path d="M8 7H6v11h11v-2" strokeLinejoin="round" />
    </svg>
  );
}
