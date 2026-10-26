"use client";

import { ComputerPane } from "./computer-pane";
import { IconTip } from "./icon-tip";
import { HidePanelIcon, MemoryIcon, MonitorIcon, TraceIcon } from "./icons";
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
  snapshot?: ComputerSnapshot | null;
  status?: "loading" | "ready" | "error";
  messages?: Message[];
}) {
  const memoryLabel = memories && memories.length > 0 ? `Memory ${memories.length}` : "Memory";
  return (
    <aside
      className="computer"
      aria-label={tab === "memory" ? "Memory" : tab === "trace" ? "Trace" : "Computer"}
    >
      <header className="pane-h">
        <div className="pane-tabs" role="tablist" aria-label="Side panel">
          <IconTip
            label="Computer"
            role="tab"
            aria-selected={tab === "computer"}
            className={tab === "computer" ? "on" : undefined}
            onClick={() => onTab("computer")}
          >
            <MonitorIcon />
          </IconTip>
          <IconTip
            label={memoryLabel}
            role="tab"
            aria-selected={tab === "memory"}
            className={tab === "memory" ? "on" : undefined}
            onClick={() => onTab("memory")}
          >
            <MemoryIcon />
            {memories && memories.length > 0 ? (
              <span className="tab-badge" aria-hidden="true">
                {memories.length}
              </span>
            ) : null}
          </IconTip>
          <IconTip
            label="Trace"
            role="tab"
            aria-selected={tab === "trace"}
            className={tab === "trace" ? "on" : undefined}
            onClick={() => onTab("trace")}
          >
            <TraceIcon />
          </IconTip>
        </div>
        {onHide ? (
          <IconTip label="Hide" onClick={onHide}>
            <HidePanelIcon />
          </IconTip>
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
        <ComputerPane embedded snapshot={snapshot} status={status} />
      )}
    </aside>
  );
}
