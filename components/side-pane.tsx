"use client";

import {
  ComputerPane,
  PANE_WIDTH_MAX,
  PANE_WIDTH_MIN,
  clampPaneWidth,
  resizePaneWidth,
  type ComputerContentTab,
} from "./computer-pane";
import { IconTip } from "./icon-tip";
import { HidePanelIcon, MemoryIcon, MonitorIcon, PopOutIcon, TraceIcon } from "./icons";
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
  unavailableReason = null,
  messages = [],
  popped = false,
  onPop,
  paneWidth,
  onPaneWidth,
  onComputerTab,
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
  unavailableReason?: string | null;
  messages?: Message[];
  popped?: boolean;
  onPop?: () => void;
  paneWidth?: number;
  onPaneWidth?: (width: number) => void;
  onComputerTab?: (tab: ComputerContentTab) => void;
}) {
  const memoryLabel = memories && memories.length > 0 ? `Memory ${memories.length}` : "Memory";
  const resizable = paneWidth != null && onPaneWidth != null;
  return (
    <aside
      className={popped ? "computer popped" : "computer"}
      style={popped && paneWidth != null ? { width: paneWidth } : undefined}
      aria-label={tab === "memory" ? "Memory" : tab === "trace" ? "Trace" : "Computer"}
    >
      {resizable ? <PaneResize width={paneWidth} onWidth={onPaneWidth} /> : null}
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
        <div className="pane-actions">
          {onPop ? (
            <IconTip label={popped ? "Dock" : "Pop out"} onClick={onPop}>
              <PopOutIcon />
            </IconTip>
          ) : null}
          {onHide ? (
            <IconTip label="Hide" onClick={onHide}>
              <HidePanelIcon />
            </IconTip>
          ) : null}
        </div>
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
          snapshot={snapshot}
          status={status}
          activities={activities}
          unavailableReason={unavailableReason}
          onContentTab={onComputerTab}
        />
      )}
    </aside>
  );
}

function PaneResize({ width, onWidth }: { width: number; onWidth: (width: number) => void }) {
  return (
    <div
      className="computer-resize"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize computer pane"
      aria-valuemin={PANE_WIDTH_MIN}
      aria-valuemax={PANE_WIDTH_MAX}
      aria-valuenow={width}
      tabIndex={0}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        const startX = event.clientX;
        const startWidth = width;
        const move = (next: PointerEvent) => {
          onWidth(resizePaneWidth(startWidth, startX, next.clientX));
        };
        const up = () => {
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", up);
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
      }}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 40 : 16;
        if (event.key === "ArrowLeft") {
          event.preventDefault();
          onWidth(clampPaneWidth(width + step));
        } else if (event.key === "ArrowRight") {
          event.preventDefault();
          onWidth(clampPaneWidth(width - step));
        }
      }}
    />
  );
}
