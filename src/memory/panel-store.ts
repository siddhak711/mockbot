"use client";

import { useSyncExternalStore } from "react";
import type { Memory, MemoryProposal } from "../types";
import type { ScopeTab } from "./panel-logic";
import { UNDO_MS } from "./panel-logic";

export type MemoryUndo = {
  id: string;
  label: string;
  key: string;
  expiresAt: number;
  action: "forget" | "save";
  hiddenIds: string[];
  memoryIds: string[];
  proposal: MemoryProposal | null;
};

export type MemoryPanelState = {
  tab: ScopeTab;
  query: string;
  selectedId: string | null;
  flashId: string | null;
  memories: Memory[] | null;
  proposals: MemoryProposal[];
  error: string | null;
  undos: MemoryUndo[];
};

const SESSION_KEY = "mockbot.memory.panel";

const initialState: MemoryPanelState = {
  tab: "all",
  query: "",
  selectedId: null,
  flashId: null,
  memories: null,
  proposals: [],
  error: null,
  undos: [],
};

let state: MemoryPanelState = initialState;
const listeners = new Set<() => void>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
let hydrated = false;

function emit() {
  for (const listener of listeners) listener();
}

function persist() {
  if (typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.setItem(
      SESSION_KEY,
      JSON.stringify({ tab: state.tab, query: state.query, selectedId: state.selectedId }),
    );
  } catch {
    // Private browsing can reject the write. The in-memory panel still works.
  }
}

export function getMemoryPanelState(): MemoryPanelState {
  return state;
}

export function subscribeMemoryPanel(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function patchMemoryPanel(patch: Partial<MemoryPanelState>) {
  state = { ...state, ...patch };
  if ("tab" in patch || "query" in patch || "selectedId" in patch) persist();
  emit();
}

export function replaceMemoryData(input: {
  memories: Memory[] | null;
  proposals?: MemoryProposal[];
  error: string | null;
}) {
  patchMemoryPanel({
    memories: input.memories,
    proposals: input.proposals ?? [],
    error: input.error,
  });
}

export function hydrateMemoryPanel() {
  if (hydrated || typeof sessionStorage === "undefined") return;
  hydrated = true;
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Partial<
      Pick<MemoryPanelState, "tab" | "query" | "selectedId">
    >;
    const tab = parsed.tab;
    const allowed: ScopeTab[] = ["all", "profile", "journal", "shared", "chat"];
    patchMemoryPanel({
      ...(tab && allowed.includes(tab) ? { tab } : {}),
      ...(typeof parsed.query === "string" ? { query: parsed.query } : {}),
      ...(typeof parsed.selectedId === "string" || parsed.selectedId === null
        ? { selectedId: parsed.selectedId ?? null }
        : {}),
    });
  } catch {
    // Ignore a corrupt session blob.
  }
}

export function resetMemoryPanelStore() {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  hydrated = true;
  state = { ...initialState, memories: null, proposals: [], undos: [] };
  if (typeof sessionStorage !== "undefined") {
    try {
      sessionStorage.removeItem(SESSION_KEY);
    } catch {
      // Ignore.
    }
  }
  emit();
}

export function useMemoryPanel(): MemoryPanelState {
  return useSyncExternalStore(subscribeMemoryPanel, getMemoryPanelState, getMemoryPanelState);
}

export function hiddenMemoryIds(snapshot: MemoryPanelState = state): Set<string> {
  const ids = new Set<string>();
  for (const undo of snapshot.undos) {
    if (undo.action !== "forget") continue;
    for (const id of undo.hiddenIds) ids.add(id);
  }
  return ids;
}

export function queueMemoryUndo(
  undo: Omit<MemoryUndo, "expiresAt"> & { expiresAt?: number },
  commit: (undo: MemoryUndo) => void,
) {
  const next: MemoryUndo = { ...undo, expiresAt: undo.expiresAt ?? Date.now() + UNDO_MS };
  state = { ...state, undos: [...state.undos, next] };
  emit();
  const delay = Math.max(0, next.expiresAt - Date.now());
  const timer = setTimeout(() => {
    timers.delete(next.id);
    if (!state.undos.some((item) => item.id === next.id)) return;
    commit(next);
    state = { ...state, undos: state.undos.filter((item) => item.id !== next.id) };
    emit();
  }, delay);
  timers.set(next.id, timer);
  return next;
}

export function undoMemory(id?: string): MemoryUndo | null {
  const current = id
    ? state.undos.find((item) => item.id === id)
    : state.undos[state.undos.length - 1];
  if (!current) return null;
  const timer = timers.get(current.id);
  if (timer) clearTimeout(timer);
  timers.delete(current.id);
  state = { ...state, undos: state.undos.filter((item) => item.id !== current.id) };
  emit();
  return current;
}

export function undoLatestMemory(): MemoryUndo | null {
  return undoMemory();
}

export function upsertMemory(memory: Memory) {
  const memories = state.memories ?? [];
  const index = memories.findIndex(
    (item) =>
      item.id === memory.id ||
      (item.agentId === memory.agentId && item.key.toLowerCase() === memory.key.toLowerCase()),
  );
  const next = memories.slice();
  if (index >= 0) {
    const previous = memories[index]!;
    const prior = { ...previous, history: [] };
    next[index] = {
      ...memory,
      history: (memory.history?.length ? memory.history : [prior, ...previous.history]).filter(
        (item) => item.id !== memory.id,
      ),
    };
  } else {
    next.unshift({ ...memory, history: memory.history ?? [] });
  }
  patchMemoryPanel({ memories: next, error: null });
}

export function removeMemories(ids: readonly string[]) {
  const drop = new Set(ids);
  patchMemoryPanel({
    memories: (state.memories ?? []).filter((memory) => !drop.has(memory.id)),
  });
}

export function removeProposal(id: string) {
  patchMemoryPanel({ proposals: state.proposals.filter((proposal) => proposal.id !== id) });
}

export function replaceProposal(proposal: MemoryProposal) {
  const rest = state.proposals.filter(
    (item) => item.id !== proposal.id && item.fingerprint !== proposal.fingerprint,
  );
  patchMemoryPanel({ proposals: [proposal, ...rest] });
}
