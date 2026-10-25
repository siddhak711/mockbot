"use client";

import { useEffect, useState } from "react";
import type { ComputerSnapshot, SandboxRun } from "../src/sandbox/types";

export function ComputerPane({
  snapshot = null,
  status = "loading",
  onHide,
}: {
  snapshot?: ComputerSnapshot | null;
  status?: "loading" | "ready" | "error";
  onHide?: () => void;
}) {
  const runs = snapshot?.runs ?? [];
  const latestId = runs[0]?.id ?? null;
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    setSelectedId(latestId);
  }, [latestId]);

  const selected = runs.find((run) => run.id === selectedId) ?? runs[0] ?? null;
  const provider =
    snapshot?.provider === "daytona" ? "Daytona sandbox" : snapshot ? "Mock sandbox" : "Sandbox";

  return (
    <aside className="computer" aria-label="Computer">
      <header className="pane-h">
        <div>
          <h2>Computer</h2>
          <p className="computer-kicker">{provider}</p>
        </div>
        {onHide ? (
          <button type="button" className="ghost-text" onClick={onHide}>
            Hide
          </button>
        ) : null}
      </header>
      {status === "loading" && !snapshot ? (
        <div className="computer-empty">
          <h3>Loading computer</h3>
          <p>The sandbox inspector will show commands, output, and exit codes.</p>
        </div>
      ) : status === "error" && !snapshot ? (
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
          {runs.length === 0 || !selected ? (
            <div className="computer-empty">
              <h3>Nothing has run</h3>
              <p>
                Ask the agent to create a file or run a command. The command, output, and exit code
                show up here.
              </p>
            </div>
          ) : (
            <>
              <div className="computer-list" role="list" aria-label="Sandbox runs">
                {runs.map((run) => (
                  <button
                    key={run.id}
                    type="button"
                    role="listitem"
                    className={run.id === selected.id ? "computer-item on" : "computer-item"}
                    aria-current={run.id === selected.id ? "true" : undefined}
                    onClick={() => setSelectedId(run.id)}
                  >
                    <span>{runTitle(run)}</span>
                    <span className="computer-status">{exitLabel(run)}</span>
                  </button>
                ))}
              </div>
              <RunDetail run={selected} />
            </>
          )}
        </div>
      )}
    </aside>
  );
}

function RunDetail({ run }: { run: SandboxRun }) {
  const command = run.command ?? runTitle(run);
  const output = run.stdout || run.stderr || "(no output)";
  return (
    <section
      className="computer-detail"
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
