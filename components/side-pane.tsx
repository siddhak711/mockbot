"use client";

import { ComputerPane } from "./computer-pane";
import { MemoryPanel } from "./memory-panel";
import { TokenStreamPanel } from "./token-stream";
import type { ComputerSnapshot } from "../src/sandbox/types";
import type { ToolActivity } from "../src/tools/display";
import type { Memory, Message } from "../src/types";

export type SideTab = "computer" | "memory" | "trace";

export function SidePane({
  tab,
  onTab,
  onHide,
  memories,
  memoryError,
  agentId,
  onMemoriesChanged,
  activities = [],
  selectedId,
  onSelect,
  snapshot = null,
  status = "ready",
  messages = [],
}: {
  tab: SideTab;
  onTab: (tab: SideTab) => void;
  onHide?: () => void;
  memories: Memory[] | null;
  memoryError: string | null;
  agentId: string;
  onMemoriesChanged: () => Promise<void>;
  activities?: ToolActivity[];
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  snapshot?: ComputerSnapshot | null;
  status?: "loading" | "ready" | "error";
  messages?: Message[];
}) {
  return (
    <aside
      className="computer"
      aria-label={tab === "memory" ? "Memory" : tab === "trace" ? "Trace" : "Computer"}
    >
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
          <button
            type="button"
            role="tab"
            aria-selected={tab === "trace"}
            className={tab === "trace" ? "on" : undefined}
            onClick={() => onTab("trace")}
          >
            Trace
          </button>
        </div>
        {onHide ? (
          <button type="button" className="ghost-text" onClick={onHide}>
            Hide
          </button>
        ) : null}
      </header>
      {tab === "memory" ? (
        <MemoryPanel
          memories={memories}
          error={memoryError}
          agentId={agentId}
          onChanged={onMemoriesChanged}
        />
      ) : tab === "trace" ? (
        <TokenStreamPanel messages={messages} activities={activities} />
      ) : (
        <ComputerPane
          embedded
          activities={activities}
          selectedId={selectedId}
          onSelect={onSelect}
          snapshot={snapshot}
          status={status}
        />
      )}
    </aside>
  );
}
