"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { ComputerSnapshot, SandboxRun } from "../src/sandbox/types";
import type { SpriteState } from "../src/sprite";
import { BotSprite } from "./bot-sprite";

export type ChangedFileRef = {
  path: string;
  runId: string;
};

export type ComputerLoad = "loading" | "ready" | "error";

/** Header status. Derived from the load state and sandbox tool activity. */
export type ComputerPresence = "idle" | "working" | "needs_help" | "offline";

export type ComputerContentTab = "screen" | "terminal" | "files" | "browser";

export type ComputerActivity = {
  name: string;
  state: string;
};

export const COMPUTER_LOADING_DELAY_MS = 150;
export const PANE_WIDTH_DEFAULT = 420;
export const PANE_WIDTH_MIN = 360;
export const PANE_WIDTH_MAX = 720;
export const PANE_WIDTH_SCREEN = 560;

const CONTENT_TABS: readonly ComputerContentTab[] = ["screen", "terminal", "files", "browser"];
const SANDBOX_TOOLS = new Set(["list", "read", "write", "exec"]);

const TAB_LABEL: Record<ComputerContentTab, string> = {
  screen: "Screen",
  terminal: "Terminal",
  files: "Files",
  browser: "Browser",
};

export function ComputerPane({
  snapshot = null,
  status = "ready",
  activities = [],
  embedded = false,
  onContentTab,
}: {
  snapshot?: ComputerSnapshot | null;
  status?: ComputerLoad;
  activities?: readonly ComputerActivity[];
  embedded?: boolean;
  onContentTab?: (tab: ComputerContentTab) => void;
}) {
  const runs = snapshot?.runs ?? [];
  const latestId = runs[0]?.id ?? null;
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [allFilesOpen, setAllFilesOpen] = useState(false);
  const [contentTab, setContentTab] = useState<ComputerContentTab>("files");
  const [showLoading, setShowLoading] = useState(false);
  const tabRefs = useRef<Partial<Record<ComputerContentTab, HTMLButtonElement | null>>>({});
  const baseId = useId();

  useEffect(() => {
    setSelectedRunId(latestId);
  }, [latestId]);

  useEffect(() => {
    if (status !== "loading" || snapshot) {
      setShowLoading(false);
      return;
    }
    const timer = window.setTimeout(() => setShowLoading(true), COMPUTER_LOADING_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [status, snapshot]);

  const activeRunId = runs.some((run) => run.id === selectedRunId)
    ? selectedRunId
    : (runs[0]?.id ?? null);
  const presence = computerPresence(status, snapshot != null, activities);
  const provider = providerLabel(snapshot);
  const changed = filesChanged(runs);
  const blocked = !snapshot && (status === "loading" || status === "error");

  function selectTab(tab: ComputerContentTab, focus = false) {
    if (tab !== contentTab) onContentTab?.(tab);
    setContentTab(tab);
    if (focus) tabRefs.current[tab]?.focus();
  }

  function onTabsKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const index = CONTENT_TABS.indexOf(contentTab);
    if (event.key === "ArrowRight") {
      event.preventDefault();
      selectTab(CONTENT_TABS[(index + 1) % CONTENT_TABS.length] ?? "files", true);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      selectTab(
        CONTENT_TABS[(index - 1 + CONTENT_TABS.length) % CONTENT_TABS.length] ?? "files",
        true,
      );
    }
  }

  const header = (
    <div className="computer-head">
      <BotSprite state={presenceSprite(presence)} size={22} />
      <div className="computer-head-copy">
        <h2 className="computer-head-title">
          mockbot&apos;s computer
          <span className="computer-head-provider"> · {provider}</span>
        </h2>
      </div>
      <p
        className="computer-presence"
        role="status"
        aria-live={presence === "needs_help" ? "assertive" : "polite"}
      >
        <span className={`computer-presence-dot ${presence}`} aria-hidden="true" />
        {presenceLabel(presence)}
      </p>
    </div>
  );

  const tabs = (
    <div
      className="computer-tabs"
      role="tablist"
      aria-label="Computer contents"
      onKeyDown={onTabsKeyDown}
    >
      {CONTENT_TABS.map((tab) => {
        const selected = contentTab === tab;
        return (
          <button
            key={tab}
            ref={(node) => {
              tabRefs.current[tab] = node;
            }}
            type="button"
            role="tab"
            id={`${baseId}-tab-${tab}`}
            aria-controls={`${baseId}-panel-${tab}`}
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => selectTab(tab)}
          >
            {TAB_LABEL[tab]}
            {tab === "files" ? <span className="computer-tab-count"> {changed.length}</span> : null}
          </button>
        );
      })}
    </div>
  );

  let panel: ReactNode;
  if (blocked && status === "loading") {
    panel = showLoading ? (
      <div className="computer-loading">
        <div className="computer-skeleton" aria-hidden="true" />
        <h3>Loading computer</h3>
        <p>The sandbox inspector will show files changed in this run.</p>
      </div>
    ) : (
      <div className="computer-loading" aria-busy="true" />
    );
  } else if (blocked && status === "error") {
    panel = (
      <div className="computer-empty">
        <h3>Computer unavailable</h3>
        <p>The sandbox inspector could not be loaded.</p>
      </div>
    );
  } else if (contentTab === "terminal") {
    panel = <TerminalMirror runs={runs} id={`${baseId}-panel-terminal`} />;
  } else if (contentTab === "screen") {
    panel = (
      <div
        className="computer-empty"
        role="tabpanel"
        id={`${baseId}-panel-screen`}
        aria-labelledby={`${baseId}-tab-screen`}
      >
        <h3>Nothing on screen yet</h3>
        <p>When mockbot uses its computer, you&apos;ll see it here live.</p>
      </div>
    );
  } else if (contentTab === "browser") {
    panel = (
      <BrowserPlaceholder id={`${baseId}-panel-browser`} labelledBy={`${baseId}-tab-browser`} />
    );
  } else {
    panel = (
      <div role="tabpanel" id={`${baseId}-panel-files`} aria-labelledby={`${baseId}-tab-files`}>
        <FilesChanged
          changed={changed}
          activeRunId={activeRunId}
          snapshot={snapshot}
          allFilesOpen={allFilesOpen}
          onSelect={setSelectedRunId}
          onToggleAll={() => setAllFilesOpen((open) => !open)}
        />
      </div>
    );
  }

  const body = (
    <>
      {header}
      {tabs}
      <div className="computer-body">{panel}</div>
    </>
  );

  if (embedded) return <div className="computer-embedded">{body}</div>;

  return (
    <aside className="computer" aria-label="Computer">
      {body}
    </aside>
  );
}

function FilesChanged({
  changed,
  activeRunId,
  snapshot,
  allFilesOpen,
  onSelect,
  onToggleAll,
}: {
  changed: ChangedFileRef[];
  activeRunId: string | null;
  snapshot: ComputerSnapshot | null;
  allFilesOpen: boolean;
  onSelect: (runId: string) => void;
  onToggleAll: () => void;
}) {
  return (
    <section className="computer-files" aria-label="Files changed">
      <h3>Files changed</h3>
      {changed.length > 0 ? (
        <ul>
          {changed.map((file) => (
            <li key={file.path}>
              <button
                type="button"
                className={
                  file.runId === activeRunId ? "computer-file-link on" : "computer-file-link"
                }
                aria-current={file.runId === activeRunId ? "true" : undefined}
                onClick={() => onSelect(file.runId)}
              >
                {file.path}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p>No files changed.</p>
      )}
      {snapshot && snapshot.files.length > 0 ? (
        <>
          <button
            type="button"
            className="ghost-text computer-expand"
            aria-expanded={allFilesOpen}
            onClick={onToggleAll}
          >
            {allFilesOpen ? "Hide all files" : "All files"}
          </button>
          {allFilesOpen ? (
            <ul aria-label="All sandbox files">
              {snapshot.files.map((file) => (
                <li key={file.path}>{file.kind === "dir" ? `${file.path}/` : file.path}</li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

function TerminalMirror({ runs, id }: { runs: readonly SandboxRun[]; id: string }) {
  const ordered = [...runs].reverse();
  return (
    <div
      className="computer-terminal"
      role="tabpanel"
      id={id}
      aria-label="Terminal"
      aria-readonly="true"
    >
      {ordered.length === 0 ? (
        <p className="computer-terminal-empty">No commands yet.</p>
      ) : (
        ordered.map((run) => {
          const command = terminalCommand(run);
          return (
            <article
              key={run.id}
              className="computer-term-run"
              data-run-id={run.id}
              aria-label={command}
            >
              <p className="computer-term-line">
                <span className="computer-term-prompt">sandbox:~$</span>{" "}
                <span className="computer-term-cmd">{command}</span>
              </p>
              {run.stdout ? <pre className="computer-term-out">{run.stdout}</pre> : null}
              {run.stderr ? <pre className="computer-term-err">{run.stderr}</pre> : null}
              <p className="computer-term-meta">{terminalMeta(run)}</p>
            </article>
          );
        })
      )}
    </div>
  );
}

function BrowserPlaceholder({ id, labelledBy }: { id: string; labelledBy: string }) {
  return (
    <div className="computer-browser" role="tabpanel" id={id} aria-labelledby={labelledBy}>
      <div className="computer-browser-bar">
        <button type="button" className="icon-btn" disabled aria-label="Back">
          ‹
        </button>
        <button type="button" className="icon-btn" disabled aria-label="Forward">
          ›
        </button>
        <button type="button" className="icon-btn" disabled aria-label="Reload">
          ↻
        </button>
        <input
          className="computer-browser-url"
          readOnly
          value=""
          placeholder="No page yet"
          aria-label="Address"
        />
      </div>
      <div className="computer-empty">
        <h3>Nothing on screen yet</h3>
        <p>Browser pages show up here when mockbot opens one.</p>
      </div>
    </div>
  );
}

export function filesChanged(runs: readonly SandboxRun[]): ChangedFileRef[] {
  const seen = new Set<string>();
  const files: ChangedFileRef[] = [];
  for (const run of runs) {
    for (const path of run.changedFiles) {
      if (!path || seen.has(path)) continue;
      seen.add(path);
      files.push({ path, runId: run.id });
    }
  }
  return files;
}

export function providerLabel(snapshot: ComputerSnapshot | null | undefined): string {
  if (!snapshot) return "Sandbox";
  if (snapshot.provider === "daytona") return "Daytona sandbox";
  return "Mock sandbox";
}

export function computerPresence(
  load: ComputerLoad,
  hasSnapshot: boolean,
  activities: readonly ComputerActivity[] = [],
): ComputerPresence {
  if (load === "error" && !hasSnapshot) return "offline";
  const sandbox = activities.filter((item) => SANDBOX_TOOLS.has(item.name));
  if (sandbox.some((item) => item.state === "approval")) return "needs_help";
  if (sandbox.some((item) => item.state === "running")) return "working";
  return "idle";
}

export function presenceLabel(presence: ComputerPresence): string {
  if (presence === "working") return "Working";
  if (presence === "needs_help") return "Needs help";
  if (presence === "offline") return "Offline";
  return "Idle";
}

export function presenceSprite(presence: ComputerPresence): SpriteState {
  if (presence === "working") return "working";
  if (presence === "needs_help") return "thinking";
  if (presence === "offline") return "error";
  return "idle";
}

export function clampPaneWidth(width: number): number {
  if (!Number.isFinite(width)) return PANE_WIDTH_DEFAULT;
  return Math.min(PANE_WIDTH_MAX, Math.max(PANE_WIDTH_MIN, Math.round(width)));
}

/** Dragging the pane's left edge: moving left grows the pane. */
export function resizePaneWidth(startWidth: number, startX: number, clientX: number): number {
  return clampPaneWidth(startWidth + (startX - clientX));
}

/** Screen opens at 560px. A wider pane stays wide. Other tabs keep the current width. */
export function widthForContentTab(current: number, tab: ComputerContentTab): number {
  if (tab !== "screen") return clampPaneWidth(current);
  return clampPaneWidth(Math.max(current, PANE_WIDTH_SCREEN));
}

export function lineCount(text: string): number {
  if (text.length === 0) return 0;
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  if (body.length === 0) return 0;
  return body.split("\n").length;
}

export function terminalCommand(run: SandboxRun): string {
  if (run.command && run.command.trim()) return run.command;
  const path = run.arguments.path;
  if (path) return `${run.tool} ${path}`;
  return run.tool;
}

export function terminalMeta(run: SandboxRun): string {
  const exit = run.timedOut
    ? "timed out"
    : run.exitCode == null
      ? "exit —"
      : `exit ${run.exitCode}`;
  const stdout = lineCount(run.stdout);
  const stderr = lineCount(run.stderr);
  return `${exit} · duration — · ${stdout} stdout ${stdout === 1 ? "line" : "lines"} · ${stderr} stderr ${stderr === 1 ? "line" : "lines"}`;
}
