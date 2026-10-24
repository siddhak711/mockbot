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

export function memoryPanelMode(
  memories: Memory[] | null,
  error: string | null,
): "loading" | "error" | "empty" | "list" {
  if (memories == null && error) return "error";
  if (memories == null) return "loading";
  if (memories.length === 0) return "empty";
  return "list";
}
