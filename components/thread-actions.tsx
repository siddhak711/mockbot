import { IconTip } from "./icon-tip";
import { MemoryIcon, MonitorIcon, PencilIcon, TrashIcon } from "./icons";

export function ThreadActions({
  active,
  streaming,
  computerOpen,
  onRename,
  onDelete,
  onMemory,
  onShowComputer,
}: {
  active: { id: string; title: string } | null;
  streaming: boolean;
  computerOpen: boolean;
  onRename: () => void;
  onDelete: () => void;
  onMemory: () => void;
  onShowComputer: () => void;
}) {
  return (
    <div className="header-actions">
      {active ? (
        <>
          <IconTip label="Rename" onClick={onRename} disabled={streaming}>
            <PencilIcon />
          </IconTip>
          <IconTip label="Delete" danger onClick={onDelete} disabled={streaming}>
            <TrashIcon />
          </IconTip>
        </>
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
