import type { Memory } from "../types";

export const MEMORY_LOAD_ERROR = "Could not load memories";

export function nextMemories(
  current: Memory[] | null,
  ok: boolean,
  loaded: Memory[] | null,
): { memories: Memory[] | null; error: string | null } {
  if (!ok) return { memories: current, error: MEMORY_LOAD_ERROR };
  return { memories: loaded ?? [], error: null };
}

export function applyMemoryRefresh(input: {
  requestedAgentId: string;
  currentAgentId: string;
  ok: boolean;
  loaded: Memory[] | null;
  current: Memory[] | null;
}): { memories: Memory[] | null; error: string | null } | null {
  if (input.currentAgentId !== input.requestedAgentId) {
    if (input.ok) return null;
    if (input.current?.some((memory) => memory.agentId === input.currentAgentId)) return null;
    return { memories: [], error: null };
  }
  if (!input.ok && input.current?.some((memory) => memory.agentId !== input.currentAgentId)) {
    return { memories: [], error: MEMORY_LOAD_ERROR };
  }
  return nextMemories(input.current, input.ok, input.loaded);
}

export function memoryPanelMode(
  memories: Memory[] | null,
  error: string | null,
): "loading" | "error" | "empty" | "list" {
  if (memories == null && error) return "error";
  if (memories == null) return "loading";
  if (memories.length === 0) return "empty";
  return "list";
}
