import { formatToolPayload, type ToolActivity } from "../src/tools/display";

export function ComputerPane({
  activities = [],
  selectedId,
  onSelect,
  onHide,
  embedded = false,
}: {
  activities?: ToolActivity[];
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  onHide?: () => void;
  embedded?: boolean;
}) {
  const selected =
    activities.find((activity) => activity.id === selectedId) ?? activities[activities.length - 1];

  const body =
    activities.length === 0 || !selected ? (
      <div className="computer-empty">
        <h3>Nothing running</h3>
        <p>Tool calls show up here while the agent works.</p>
      </div>
    ) : (
      <div className="computer-body">
        <div className="computer-list" role="list">
          {activities.map((activity) => (
            <button
              key={activity.id}
              type="button"
              role="listitem"
              className={activity.id === selected.id ? "computer-item on" : "computer-item"}
              onClick={() => onSelect?.(activity.id)}
            >
              <span>{activity.title}</span>
              <span className="computer-status">{statusLabel(activity.state)}</span>
            </button>
          ))}
        </div>
        <section className="computer-detail" aria-label={`${selected.title} details`}>
          <p className="computer-kicker">{selected.name}</p>
          <h3>{selected.title}</h3>
          {selected.state === "approval" ? (
            <p className="computer-note">
              {selected.summary} Approve or deny it in the transcript.
            </p>
          ) : null}
          {selected.arguments ? (
            <>
              <h4>Arguments</h4>
              <pre>{formatToolPayload(selected.arguments)}</pre>
            </>
          ) : null}
          {selected.output ? (
            <>
              <h4>{selected.state === "error" ? "Error" : "Result"}</h4>
              <pre>{selected.output}</pre>
            </>
          ) : selected.state === "running" ? (
            <p className="computer-note">Running…</p>
          ) : null}
        </section>
      </div>
    );

  if (embedded) return <div className="computer-embedded">{body}</div>;

  return (
    <aside className="computer" aria-label="Computer">
      <header className="pane-h">
        <h2>Computer</h2>
        {onHide ? (
          <button type="button" className="ghost-text" onClick={onHide}>
            Hide
          </button>
        ) : null}
      </header>
      {body}
    </aside>
  );
}

function statusLabel(state: ToolActivity["state"]): string {
  if (state === "running") return "Running";
  if (state === "approval") return "Needs approval";
  if (state === "denied") return "Denied";
  if (state === "error") return "Failed";
  return "Done";
}
