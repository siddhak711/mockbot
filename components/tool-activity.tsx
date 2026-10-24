import type { ToolTrace } from "../src/types";

export type ToolActivityState = "running" | "done";

export type ToolActivityKind = "search" | "read" | "draft" | "generic";

export type ToolActivity = {
  id: string;
  title: string;
  detail?: string;
  state: ToolActivityState;
  kind?: ToolActivityKind;
};

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

export function ToolActivityCards({ activities }: { activities: ToolActivity[] }) {
  if (activities.length === 0) return null;

  return (
    <div className="cards">
      {activities.map((activity) => (
        <div key={activity.id} className={activity.state === "running" ? "card live" : "card"}>
          <ToolIcon kind={activity.kind ?? "generic"} live={activity.state === "running"} />
          <div>
            <div className="card-title">{activity.title}</div>
            {activity.detail ? <div className="card-sub">{activity.detail}</div> : null}
          </div>
          <span className="state" aria-hidden="true">
            {activity.state === "running" ? <Spinner /> : <Check />}
          </span>
        </div>
      ))}
    </div>
  );
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

function ToolIcon({ kind, live }: { kind: ToolActivityKind; live: boolean }) {
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
    >
      <path d="m5 12.5 5 5L19 7.5" strokeLinecap="round" strokeLinejoin="round" />
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
