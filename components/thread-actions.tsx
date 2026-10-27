import { IconTip } from "./icon-tip";
import { MemoryIcon, MonitorIcon } from "./icons";

export function ThreadActions({
  computerOpen,
  onMemory,
  onShowComputer,
}: {
  computerOpen: boolean;
  onMemory: () => void;
  onShowComputer: () => void;
}) {
  return (
    <div className="header-actions">
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
