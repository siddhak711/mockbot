import { isLiveMemory } from "./repository";
import type { Memory, MemoryVersion } from "../types";

export function groupMemories(rows: readonly MemoryVersion[]): Memory[] {
  const live = rows.filter(isLiveMemory);
  return live.map((memory) => ({
    ...memory,
    history: rows
      .filter(
        (row) =>
          row.agentId === memory.agentId &&
          row.key.toLowerCase() === memory.key.toLowerCase() &&
          !isLiveMemory(row),
      )
      .sort((left, right) => right.validFrom.localeCompare(left.validFrom)),
  }));
}
