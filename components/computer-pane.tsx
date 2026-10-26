"use client";

import { useEffect, useState } from "react";
import type { ComputerSnapshot, SandboxRun } from "../src/sandbox/types";
import { IconTip } from "./icon-tip";
import { HidePanelIcon } from "./icons";

export type ChangedFileRef = {
  path: string;
  runId: string;
};

export function ComputerPane({
  snapshot = null,
  status = "ready",
  onHide,
  embedded = false,
}: {
  snapshot?: ComputerSnapshot | null;
  status?: "loading" | "ready" | "error";
  onHide?: () => void;
  embedded?: boolean;
}) {
  const runs = snapshot?.runs ?? [];
  const latestId = runs[0]?.id ?? null;
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [allFilesOpen, setAllFilesOpen] = useState(false);

  useEffect(() => {
    setSelectedRunId(latestId);
  }, [latestId]);

  const activeRunId = runs.some((run) => run.id === selectedRunId)
    ? selectedRunId
    : (runs[0]?.id ?? null);
  const provider =
    snapshot?.provider === "daytona" ? "Daytona sandbox" : snapshot ? "Mock sandbox" : "Sandbox";
  const changed = filesChanged(runs);

  const content =
    status === "loading" && !snapshot ? (
      <div className="computer-empty">
        <h3>Loading computer</h3>
        <p>The sandbox inspector will show files changed in this run.</p>
      </div>
    ) : status === "error" && !snapshot ? (
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
