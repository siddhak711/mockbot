"use client";

import { useEffect, useState, type ReactNode } from "react";
import type { ComputerSnapshot, SandboxRun } from "../src/sandbox/types";
import { formatToolPayload, type ToolActivity } from "../src/tools/display";
import { IconTip } from "./icon-tip";
import { HidePanelIcon } from "./icons";

const OUTPUT_PREVIEW_LINES = 20;
const OUTPUT_PREVIEW_CHARS = 1_500;
const NOISE_COMMANDS = new Set(["grep", "cat", "ls", "wc", "sed", "head", "tail", "pwd"]);

export type RunClass = "change" | "noise" | "command";

export type ChangedFileRef = {
  path: string;
  runId: string;
};

export function ComputerPane({
  activities = [],
  selectedId,
  onSelect,
  snapshot = null,
  status = "ready",
  onHide,
  embedded = false,
}: {
  activities?: ToolActivity[];
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  snapshot?: ComputerSnapshot | null;
  status?: "loading" | "ready" | "error";
  onHide?: () => void;
  embedded?: boolean;
}) {
  const runs = snapshot?.runs ?? [];
  const latestId = runs[0]?.id ?? null;
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [exploredOpen, setExploredOpen] = useState(false);
  const [allFilesOpen, setAllFilesOpen] = useState(false);

  useEffect(() => {
    setSelectedRunId(latestId);
  }, [latestId]);

  const selectedRun = runs.find((run) => run.id === selectedRunId) ?? runs[0] ?? null;
  const selectedKey = selectedRun?.id ?? null;
  const selectedClass = selectedRun ? classifyRun(selectedRun) : null;

  useEffect(() => {
    if (selectedKey && selectedClass === "noise") setExploredOpen(true);
  }, [selectedKey, selectedClass]);
  const selectedActivity =
    activities.find((activity) => activity.id === selectedId) ?? activities[activities.length - 1];
  const provider =
    snapshot?.provider === "daytona" ? "Daytona sandbox" : snapshot ? "Mock sandbox" : "Sandbox";
  const showEmpty = !selectedRun && !selectedActivity;
  const changed = filesChanged(runs);
  const activeRunId = selectedRun?.id ?? null;

  const content =
    status === "loading" && !snapshot && activities.length === 0 ? (
      <div className="computer-empty">
        <h3>Loading computer</h3>
        <p>The sandbox inspector will show commands, output, and exit codes.</p>
      </div>
    ) : status === "error" && !snapshot && activities.length === 0 ? (
      <div className="computer-empty">
        <h3>Computer unavailable</h3>
        <p>The sandbox inspector could not be loaded.</p>
      </div>
    ) : (
      <div className="computer-body">
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
                    onClick={() => setSelectedRunId(file.runId)}
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
                onClick={() => setAllFilesOpen((open) => !open)}
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
        {selectedRun ? (
          <>
            <div className="computer-list" role="list" aria-label="Sandbox runs">
              {traceRows(runs, selectedRun.id, exploredOpen, setExploredOpen, setSelectedRunId)}
            </div>
            <RunDetail key={selectedRun.id} run={selectedRun} />
          </>
        ) : null}
        {selectedActivity ? (
          <>
            <div className="computer-list" role="list" aria-label="Tool calls">
              {activities.map((activity) => (
                <button
                  key={activity.id}
                  type="button"
                  role="listitem"
                  className={
                    activity.id === selectedActivity.id ? "computer-item on" : "computer-item"
                  }
                  onClick={() => onSelect?.(activity.id)}
                >
                  <span>{activity.title}</span>
                  <span className="computer-status">{statusLabel(activity.state)}</span>
                </button>
              ))}
            </div>
            <section className="computer-detail" aria-label={`${selectedActivity.title} details`}>
              <p className="computer-kicker">{selectedActivity.name}</p>
              <h3>{selectedActivity.title}</h3>
              {selectedActivity.state === "approval" ? (
                <p className="computer-note">
                  {selectedActivity.summary} Skip or run it in the transcript.
                </p>
              ) : null}
              {selectedActivity.arguments ? (
                <>
                  <h4>Arguments</h4>
                  <pre>{formatToolPayload(selectedActivity.arguments)}</pre>
                </>
              ) : null}
              {selectedActivity.output ? (
                <>
                  <h4>{selectedActivity.state === "error" ? "Error" : "Result"}</h4>
                  <pre>{selectedActivity.output}</pre>
                </>
              ) : selectedActivity.state === "running" ? (
                <p className="computer-note">Running…</p>
              ) : null}
            </section>
          </>
        ) : null}
        {showEmpty ? (
          <div className="computer-empty">
            <h3>Nothing has run</h3>
            <p>
              Ask the agent to create a file or run a command. The command, output, and exit code
              show up here.
            </p>
          </div>
        ) : null}
      </div>
    );

  if (embedded) return <div className="computer-embedded">{content}</div>;

  return (
    <aside className="computer" aria-label="Computer">
      <header className="pane-h">
        <div>
          <h2>Computer</h2>
          <p className="computer-kicker">{provider}</p>
        </div>
        {onHide ? (
          <IconTip label="Hide" onClick={onHide}>
            <HidePanelIcon />
          </IconTip>
        ) : null}
      </header>
      {content}
    </aside>
  );
}

function traceRows(
  runs: SandboxRun[],
  selectedId: string,
  exploredOpen: boolean,
  setExploredOpen: (update: (open: boolean) => boolean) => void,
  onSelect: (id: string) => void,
): ReactNode[] {
  const noise = runs.filter((run) => classifyRun(run) === "noise");
  const label = exploredLabel(runs);
  const rows: ReactNode[] = [];
  let folded = false;
  for (const run of runs) {
    if (classifyRun(run) === "noise") {
      if (!folded && label) {
        rows.push(
          <button
            key="explored"
            type="button"
            role="listitem"
            className="computer-item"
            aria-expanded={exploredOpen}
            aria-label={label}
            onClick={() => setExploredOpen((open) => !open)}
          >
            <span>{label}</span>
            <span className="computer-status">{exploredOpen ? "Hide" : "Show"}</span>
          </button>,
        );
        if (exploredOpen) {
          rows.push(
            <div
              key="explored-runs"
              className="computer-explored-runs"
              role="list"
              aria-label="Explored commands"
            >
              {noise.map((item) => (
                <RunButton
                  key={item.id}
                  run={item}
                  selected={item.id === selectedId}
                  onSelect={onSelect}
                />
              ))}
            </div>,
          );
        }
        folded = true;
      }
      continue;
    }
    rows.push(
      <RunButton key={run.id} run={run} selected={run.id === selectedId} onSelect={onSelect} />,
    );
  }
  return rows;
}

function RunButton({
  run,
  selected,
  onSelect,
}: {
  run: SandboxRun;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  return (
    <button
      type="button"
      role="listitem"
      className={selected ? "computer-item on" : "computer-item"}
      aria-current={selected ? "true" : undefined}
      aria-label={runTitle(run)}
      onClick={() => onSelect(run.id)}
    >
      <span>{runTitle(run)}</span>
      <span className="computer-status">{exitLabel(run)}</span>
    </button>
  );
}

function RunDetail({ run }: { run: SandboxRun }) {
  const command = run.command ?? runTitle(run);
  const output = run.stdout || run.stderr || "(no output)";
  return (
    <section
      className="computer-detail sandbox-run"
      aria-label={`${command} details`}
      data-command={command}
      data-exit-code={exitLabel(run)}
    >
      <p className="computer-kicker">{run.tool}</p>
      <h3>Command</h3>
      <pre className="tool-block">{command}</pre>
      <h3>Exit code</h3>
      <p className="computer-exit">{exitLabel(run)}</p>
      <h3>Output</h3>
      <OutputBlock text={output} />
      {run.stderr && run.stdout ? (
        <>
          <h3>Error</h3>
          <OutputBlock text={run.stderr} />
        </>
      ) : null}
      {run.changedFiles.length > 0 ? (
        <>
          <h3>Changed files</h3>
          <ul className="computer-changes">
            {run.changedFiles.map((file) => (
              <li key={file}>{file}</li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}

function OutputBlock({ text }: { text: string }) {
  const [full, setFull] = useState(false);
  const preview = previewOutput(text);
  const truncated = preview.truncated && !full;
  return (
    <>
      <pre className="tool-block" data-output="true" data-truncated={truncated ? "true" : "false"}>
        {truncated ? preview.text : text}
      </pre>
      {preview.truncated ? (
        <button
          type="button"
          className="ghost-text computer-expand"
          onClick={() => setFull((open) => !open)}
        >
          {full ? "Show less" : "Show full output"}
        </button>
      ) : null}
    </>
  );
}

export function classifyRun(run: SandboxRun): RunClass {
  if (run.tool === "write") return "change";
  if (run.tool === "exec" && run.changedFiles.length > 0) return "change";
  if (run.tool === "read" || run.tool === "list") return "noise";
  if (run.tool === "exec" && noiseCommand(run.command ?? "")) return "noise";
  return "command";
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

export function exploredLabel(runs: readonly SandboxRun[]): string | null {
  const noise = runs.filter((run) => classifyRun(run) === "noise");
  if (noise.length === 0) return null;
  const files = noise.filter((run) => run.tool === "read" || run.tool === "list").length;
  const commands = noise.length - files;
  return `Explored ${tally(files, "file")} / ${tally(commands, "command")}`;
}

export function previewOutput(text: string): { text: string; truncated: boolean } {
  const lines = text.split("\n");
  let preview =
    lines.length > OUTPUT_PREVIEW_LINES ? lines.slice(0, OUTPUT_PREVIEW_LINES).join("\n") : text;
  let truncated = preview.length !== text.length;
  if (preview.length > OUTPUT_PREVIEW_CHARS) {
    preview = preview.slice(0, OUTPUT_PREVIEW_CHARS);
    truncated = true;
  }
  return { text: preview, truncated };
}

function noiseCommand(command: string): boolean {
  const trimmed = command.trim();
  if (/(?:^|\s)--version$/.test(trimmed)) return true;
  const head = trimmed.split(/\s+/, 1)[0] ?? "";
  const name = head.split("/").pop() ?? head;
  return NOISE_COMMANDS.has(name);
}

function tally(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

function runTitle(run: SandboxRun): string {
  if (run.tool === "exec" && run.command) return run.command;
  const path = run.arguments.path;
  if (path) return `${run.tool} ${path}`;
  return run.tool;
}

function exitLabel(run: SandboxRun): string {
  if (run.timedOut) return "killed";
  if (run.exitCode == null) return "failed";
  return String(run.exitCode);
}

function statusLabel(state: ToolActivity["state"]): string {
  if (state === "running") return "Running";
  if (state === "approval") return "Needs approval";
  if (state === "ask") return "Waiting for an answer";
  if (state === "plan") return "Needs plan approval";
  if (state === "denied") return "Denied";
  if (state === "error") return "Failed";
  return "Done";
}
