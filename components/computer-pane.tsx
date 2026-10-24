export function ComputerPane({
  onHide,
  embedded = false,
}: {
  onHide?: () => void;
  embedded?: boolean;
}) {
  const body = (
    <div className="computer-empty">
      <h3>Nothing here yet</h3>
      <p>Tool calls and the sandbox will show up here.</p>
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
