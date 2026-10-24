"use client";

import { ComputerPane } from "./computer-pane";
import { MemoryPanel } from "./memory-panel";
import type { Memory } from "../src/types";

export function SidePane({
  tab,
  onTab,
  onHide,
  memories,
  memoryError,
  onMemoriesChanged,
}: {
  tab: "computer" | "memory";
  onTab: (tab: "computer" | "memory") => void;
  onHide?: () => void;
  memories: Memory[] | null;
  memoryError: string | null;
  onMemoriesChanged: () => Promise<void>;
}) {
  return (
    <aside className="computer" aria-label={tab === "memory" ? "Memory" : "Computer"}>
      <header className="pane-h">
        <div className="pane-tabs" role="tablist" aria-label="Side panel">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "computer"}
            className={tab === "computer" ? "on" : undefined}
            onClick={() => onTab("computer")}
          >
            Computer
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "memory"}
            className={tab === "memory" ? "on" : undefined}
            onClick={() => onTab("memory")}
          >
            Memory{memories && memories.length > 0 ? ` ${memories.length}` : ""}
          </button>
        </div>
        {onHide ? (
          <button type="button" className="ghost-text" onClick={onHide}>
            Hide
          </button>
        ) : null}
      </header>
      {tab === "memory" ? (
        <MemoryPanel memories={memories} error={memoryError} onChanged={onMemoriesChanged} />
      ) : (
        <ComputerPane embedded />
      )}
    </aside>
  );
}
