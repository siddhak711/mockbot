import { IconTip } from "./icon-tip";
import { MemoryIcon, MonitorIcon, ReplayIcon } from "./icons";

export function ThreadActions({
  replayHref = null,
  computerOpen,
  onMemory,
  onShowComputer,
}: {
  /** The last run's replay page. The link shows only once a run has one. */
  replayHref?: string | null;
  computerOpen: boolean;
  onMemory: () => void;
  onShowComputer: () => void;
}) {
  return (
    <div className="header-actions">
      {replayHref ? (
        <a className="icon-btn tip" href={replayHref} aria-label="Replay">
          <ReplayIcon />
          <span className="tip-bubble" aria-hidden="true">
            Replay
          </span>
        </a>
      ) : null}
      <IconTip label="Memory" onClick={onMemory}>
        <MemoryIcon />
      </IconTip>
      {computerOpen ? null : (
        <IconTip label="Show computer" className="desktop-only" onClick={onShowComputer}>
          <MonitorIcon />
        </IconTip>
      )}
    </div>
  );
}
