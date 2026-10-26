import { useCallback, useState } from "react";
import {
  activityDisclosure,
  activityDisclosureOnRunning,
  activityDisclosureToggle,
} from "../src/tools/activity-open";
import type { ToolActivity } from "../src/tools/display";
import type { ToolTrace } from "../src/types";

function useActivityDisclosure(running: boolean) {
  const [disclosure, setDisclosure] = useState(() => activityDisclosure(running));
  const [wasRunning, setWasRunning] = useState(running);
  if (running !== wasRunning) {
    setWasRunning(running);
    setDisclosure((current) => activityDisclosureOnRunning(current, running));
  }
  const toggle = useCallback(() => {
    setDisclosure((current) => activityDisclosureToggle(current));
  }, []);
  return { open: disclosure.open, toggle };
}

export type { ToolActivity };

export function ToolCallCard({ tool, pending }: { tool: ToolTrace; pending: boolean }) {
  const title = tool.name || "Tool call";
  const { open, toggle } = useActivityDisclosure(pending);
  return (
    <div data-tool-name={title} data-state={pending ? "running" : "done"}>
      <button type="button" className="tool-line" aria-expanded={open} onClick={toggle}>
        <span className="tool-mark" aria-hidden="true">
          ◦
        </span>
        <span className="tool-line-title">{title}</span>
        {tool.id ? <span className="tool-line-meta">· {tool.id}</span> : null}
        <span className="sr-only">{pending ? "Running" : "Done"}</span>
      </button>
      {open ? (
        <div className="tool-expanded">
          {tool.arguments ? (
            <>
              <div className="tool-label">Arguments</div>
              <ToolText text={tool.arguments} streaming={pending} />
            </>
          ) : null}
          {tool.result != null ? (
            <>
              <div className="tool-label">Result</div>
              <ToolText text={tool.result} />
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function ToolActivityCards({
  activities,
  decidingId,
  onDecide,
  onSelect,
}: {
  activities: ToolActivity[];
  decidingId?: string | null;
  onDecide?: (id: string, decision: "approve" | "deny") => void;
  onSelect?: (id: string) => void;
}) {
  if (activities.length === 0) return null;

  return (
    <div className="cards" aria-live="polite">
      {activities.map((activity) => (
        <ActivityRow
          key={activity.id}
          activity={activity}
          decidingId={decidingId}
          onDecide={onDecide}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}

function ActivityRow({
  activity,
  decidingId,
  onDecide,
  onSelect,
}: {
  activity: ToolActivity;
  decidingId?: string | null;
  onDecide?: (id: string, decision: "approve" | "deny") => void;
  onSelect?: (id: string) => void;
}) {
  const { open, toggle } = useActivityDisclosure(activity.state === "running");
  const meta =
    activity.state === "approval"
      ? activity.summary
      : activity.state === "running"
        ? activity.detail
        : activity.preview || activity.detail;

  if (activity.state === "approval" && onDecide) {
    return (
      <article
        className="approval-card"
        data-tool={activity.name}
        data-state={activity.state}
        onClick={() => onSelect?.(activity.id)}
      >
        <div className="approval-copy">
          <div className="approval-title">{activity.title}</div>
          {activity.summary ? <div className="approval-meta">{activity.summary}</div> : null}
        </div>
        <div className="card-actions" onClick={(event) => event.stopPropagation()}>
          <button
            type="button"
            className="btn ghost deny"
            disabled={decidingId === activity.id}
            onClick={() => onDecide(activity.id, "deny")}
          >
            Skip
          </button>
          <button
            type="button"
            className="btn primary approve"
            disabled={decidingId === activity.id}
            onClick={() => {
              onSelect?.(activity.id);
              onDecide(activity.id, "approve");
            }}
          >
            Run
          </button>
        </div>
        <span className="sr-only">{statusLabel(activity.state)}</span>
      </article>
    );
  }

  return (
    <div data-tool={activity.name} data-state={activity.state}>
      <button
        type="button"
        className="tool-line"
        aria-expanded={open}
        onClick={() => {
          toggle();
          onSelect?.(activity.id);
        }}
      >
        <span className="tool-mark" aria-hidden="true">
          ◦
        </span>
        <span className="tool-line-title">{activity.title}</span>
        {meta ? <span className="tool-line-meta">· {meta}</span> : null}
        <span className="sr-only">{statusLabel(activity.state)}</span>
      </button>
      {open ? (
        <div className="tool-expanded">
          {activity.arguments ? (
            <>
              <div className="tool-label">Arguments</div>
              <ToolText text={activity.arguments} streaming={activity.state === "running"} />
            </>
          ) : null}
          {activity.output ? (
            <>
              <div className="tool-label">{activity.state === "error" ? "Error" : "Result"}</div>
              <ToolText text={activity.output} />
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function statusLabel(state: ToolActivity["state"]): string {
  if (state === "running") return "Running";
  if (state === "approval") return "Needs approval";
  if (state === "denied") return "Denied";
  if (state === "error") return "Failed";
  return "Done";
}

export function ToolText({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const lines = text.split("\n");
  const diff = lines.some(
    (line) =>
      (line.startsWith("+") && !line.startsWith("+++")) ||
      (line.startsWith("-") && !line.startsWith("---")),
  );
  const className = ["tool-block", diff ? "diff" : "", streaming ? "streaming" : ""]
    .filter(Boolean)
    .join(" ");
  if (!diff) return <pre className={className}>{text}</pre>;
  return (
    <pre className={className}>
      {lines.map((line, index) => {
        const kind =
          line.startsWith("+") && !line.startsWith("+++")
            ? "diff-add"
            : line.startsWith("-") && !line.startsWith("---")
              ? "diff-del"
              : undefined;
        return (
          <span key={`${index}:${line.slice(0, 12)}`} className={kind}>
            {line}
            {index < lines.length - 1 ? "\n" : ""}
          </span>
        );
      })}
    </pre>
  );
}
