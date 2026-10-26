import { useState } from "react";
import type { Agent } from "../src/agents/types";
import type { SignedInUser } from "../src/auth/user";
import { UserMenu } from "./user-menu";
import type { SpriteState } from "../src/sprite";
import { runtimeStatusLabel, type RuntimeStatus } from "../src/token-stream";
import { AgentPanel, type AgentDraft } from "./agent-panel";
import { ClockIcon, GearIcon, PlugIcon, TrafficLights } from "./icons";
import { ThemeToggle } from "./theme";

export function Sidebar({
  agents,
  activeAgentId,
  spriteState,
  runtimeStatus,
  busy,
  open,
  onSelectAgent,
  onCreateAgent,
  onOpenConnectors,
  user,
}: {
  agents: Agent[];
  activeAgentId: string;
  spriteState: SpriteState;
  runtimeStatus: RuntimeStatus;
  busy: boolean;
  open: boolean;
  onSelectAgent: (id: string) => void;
  onCreateAgent: (draft: AgentDraft) => Promise<string | null>;
  onOpenConnectors?: () => void;
  user: SignedInUser;
}) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const status = runtimeStatusLabel(runtimeStatus);

  return (
    <aside className={open ? "sidebar open" : "sidebar"} aria-label="Agents">
      <div className="side-head">
        <TrafficLights />
        <span className="grow" />
        <ThemeToggle />
      </div>
      <a className="nav-action" href="/routines">
        <ClockIcon />
        Routines
      </a>
      {onOpenConnectors ? (
        <button type="button" className="nav-action" onClick={onOpenConnectors}>
          <PlugIcon />
          Connectors
        </button>
      ) : null}
      <div className="sidebar-sections">
        <AgentPanel
          agents={agents}
          activeAgentId={activeAgentId}
          spriteState={spriteState}
          busy={busy}
          onSelect={onSelectAgent}
          onCreate={onCreateAgent}
        />
      </div>
      <footer className="me" title={status.full}>
        <UserMenu user={user} detail={`${status.title} · ${status.subtitle}`} />
        {onOpenConnectors ? (
          <span className="settings-anchor">
            {settingsOpen ? (
              <div className="settings-pop menu" role="menu" aria-label="Settings">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setSettingsOpen(false);
                    onOpenConnectors();
                  }}
                >
                  Connectors
                </button>
              </div>
            ) : null}
            <button
              type="button"
              className="icon-btn"
              aria-label="Settings"
              aria-expanded={settingsOpen}
              aria-haspopup="menu"
              onClick={() => setSettingsOpen((value) => !value)}
            >
              <GearIcon />
            </button>
          </span>
        ) : null}
      </footer>
    </aside>
  );
}
