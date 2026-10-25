import type { ToolActivity } from "../src/tools/display";
import type { ToolTrace } from "../src/types";

export type { ToolActivity };

export function ToolCallCard({ tool, pending }: { tool: ToolTrace; pending: boolean }) {
  const title = tool.name || "Tool call";
  return (
    <div
      className={pending ? "card live" : "card"}
      aria-label={`Tool call ${title}`}
      data-tool-name={title}
    >
      <ToolGlyph live={pending} />
      <div className="card-body">
        <div className="card-title">{title}</div>
        {tool.id ? <div className="card-sub">{tool.id}</div> : null}
        {tool.arguments ? (
          <>
            <div className="tool-label">Arguments</div>
            <pre className={pending ? "tool-block streaming" : "tool-block"}>{tool.arguments}</pre>
          </>
        ) : null}
        {tool.result != null ? (
          <>
            <div className="tool-label">Result</div>
            <pre className="tool-block">{tool.result}</pre>
          </>
        ) : null}
      </div>
      <span className="state" aria-hidden="true">
        {tool.result != null ? <Check /> : pending ? <Spinner /> : null}
      </span>
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
      {activities.map((activity) => {
        const pending = activity.state === "approval";
        const sub = pending
          ? activity.summary
          : activity.state === "running"
            ? activity.detail
            : activity.preview || activity.detail;
        const className = [
          "card",
          activity.state === "running" ? "live" : "",
          pending ? "needs-approval" : "",
          activity.state === "error" ? "failed" : "",
          activity.state === "denied" ? "denied" : "",
        ]
          .filter(Boolean)
          .join(" ");
        return (
          <div
            key={activity.id}
            className={className}
            data-tool={activity.name}
            data-state={activity.state}
            onClick={() => onSelect?.(activity.id)}
          >
            <ToolIcon kind={activity.kind} live={activity.state === "running"} />
            <div>
              <button type="button" className="card-title" onClick={() => onSelect?.(activity.id)}>
                {activity.title}
              </button>
              {sub ? <div className="card-sub">{sub}</div> : null}
              {pending && onDecide ? (
                <div className="card-actions" onClick={(event) => event.stopPropagation()}>
                  <button
                    type="button"
                    className="deny"
                    disabled={decidingId === activity.id}
                    onClick={() => onDecide(activity.id, "deny")}
                  >
                    Deny
                  </button>
                  <button
                    type="button"
                    className="approve"
                    disabled={decidingId === activity.id}
                    onClick={() => onDecide(activity.id, "approve")}
                  >
                    Approve
                  </button>
                </div>
              ) : null}
            </div>
            <span className="state">
              <span className="sr-only">{statusLabel(activity.state)}</span>
              <StatusIcon state={activity.state} />
            </span>
          </div>
        );
      })}
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

function StatusIcon({ state }: { state: ToolActivity["state"] }) {
  if (state === "running") return <Spinner />;
  if (state === "approval") return <Dot />;
  if (state === "error" || state === "denied") return <Cross />;
  return <Check />;
}

function ToolGlyph({ live }: { live: boolean }) {
  const stroke = live ? "#f2f2f2" : "#d6d6d6";
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke={stroke}
      strokeWidth="1.75"
      aria-hidden="true"
    >
      <path d="M8 7.5 12 12l-4 4.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M13 16.5h5" strokeLinecap="round" />
    </svg>
  );
}

function ToolIcon({ kind, live }: { kind: ToolActivity["kind"]; live: boolean }) {
  const stroke = live ? "#f2f2f2" : "#d6d6d6";
  if (kind === "search") {
    return (
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke={stroke}
        strokeWidth="1.75"
        aria-hidden="true"
      >
        <circle cx="11" cy="11" r="6.25" />
        <path d="M16 16.5 20 20.5" strokeLinecap="round" />
      </svg>
    );
  }
  if (kind === "read") {
    return (
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke={stroke}
        strokeWidth="1.75"
        aria-hidden="true"
      >
        <path d="M6 4.5h10.5a2 2 0 0 1 2 2V19.5H8a2 2 0 0 0-2 2v-15a2 2 0 0 1 2-2Z" />
        <path d="M6 19.5h12.5" />
      </svg>
    );
  }
  if (kind === "draft") {
    return (
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke={stroke}
        strokeWidth="1.75"
        aria-hidden="true"
      >
        <path d="M7 3.5h7l5 5V20.5H7z" />
        <path d="M14 3.5V8.5h5" />
      </svg>
    );
  }
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke={stroke}
      strokeWidth="1.75"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="7.25" />
      <path d="M12 8.5v4l2.5 1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Check() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      aria-hidden="true"
    >
      <path d="m5 12.5 5 5L19 7.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Cross() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      aria-hidden="true"
    >
      <path d="M7 7l10 10M17 7 7 17" strokeLinecap="round" />
    </svg>
  );
}

function Dot() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="3" fill="#e6c37a" />
    </svg>
  );
}

function Spinner() {
  return (
    <svg className="spinner" width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="6" fill="none" stroke="#3a3a3a" strokeWidth="1.6" />
      <path
        d="M8 2a6 6 0 0 1 6 6"
        fill="none"
        stroke="#f2f2f2"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}
