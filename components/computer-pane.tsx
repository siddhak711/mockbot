"use client";

import { useEffect, useState } from "react";
import type { ComputerSnapshot, SandboxRun } from "../src/sandbox/types";
import { formatToolPayload, type ToolActivity } from "../src/tools/display";
import { IconTip } from "./icon-tip";
import { HidePanelIcon } from "./icons";

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

  useEffect(() => {
    setSelectedRunId(latestId);
  }, [latestId]);

  const selectedRun = runs.find((run) => run.id === selectedRunId) ?? runs[0] ?? null;
  const selectedActivity =
    activities.find((activity) => activity.id === selectedId) ?? activities[activities.length - 1];
  const provider =
    snapshot?.provider === "daytona" ? "Daytona sandbox" : snapshot ? "Mock sandbox" : "Sandbox";
  const showEmpty = !selectedRun && !selectedActivity;

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
        <section className="computer-files" aria-label="Sandbox files">
          <h3>Files</h3>
          {snapshot && snapshot.files.length > 0 ? (
            <ul>
              {snapshot.files.map((file) => (
                <li key={file.path}>{file.kind === "dir" ? `${file.path}/` : file.path}</li>
              ))}
            </ul>
          ) : (
            <p>No files yet.</p>
          )}
        </section>
        {selectedRun ? (
          <>
            <div className="computer-list" role="list" aria-label="Sandbox runs">
              {runs.map((run) => (
                <button
                  key={run.id}
                  type="button"
                  role="listitem"
                  className={run.id === selectedRun.id ? "computer-item on" : "computer-item"}
                  aria-current={run.id === selectedRun.id ? "true" : undefined}
                  onClick={() => setSelectedRunId(run.id)}
                >
                  <span>{runTitle(run)}</span>
                  <span className="computer-status">{exitLabel(run)}</span>
                </button>
              ))}
            </div>
            <RunDetail run={selectedRun} />
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
      <pre className="tool-block" data-output="true">
        {output}
      </pre>
      {run.stderr && run.stdout ? (
        <>
          <h3>Error</h3>
          <pre className="tool-block">{run.stderr}</pre>
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
  if (state === "denied") return "Denied";
  if (state === "error") return "Failed";
  return "Done";
}
