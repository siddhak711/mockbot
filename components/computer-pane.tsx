export function ComputerPane({ onHide }: { onHide?: () => void }) {
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
      <div className="computer-empty">
        <h3>Nothing here yet</h3>
        <p>Tool calls and the sandbox will show up here.</p>
      </div>
    </aside>
  );
}
