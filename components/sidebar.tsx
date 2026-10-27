import type { Agent } from "../src/agents/types";
import type { SignedInUser } from "../src/auth/user";
import { UserMenu } from "./user-menu";
import { spriteColorForAgent, type SpriteState } from "../src/sprite";
import { runtimeStatusLabel, type RuntimeStatus } from "../src/token-stream";
import { AgentPanel, type AgentDraft } from "./agent-panel";
import { BotSprite } from "./bot-sprite";
import { ClockIcon, HidePanelIcon, PlugIcon, TrafficLights } from "./icons";
import { ThemeToggle } from "./theme";

function userLabel(user: SignedInUser): string {
  return user.name?.trim() || user.email;
}

function UserAvatar({ user }: { user: SignedInUser }) {
  const label = userLabel(user);
  if (user.image) {
    return <img className="ava ava-img" src={user.image} alt="" referrerPolicy="no-referrer" />;
  }
  return (
    <span className="ava" aria-hidden="true">
      {label.charAt(0).toUpperCase() || "?"}
    </span>
  );
}

export function Sidebar({
  agents,
  activeAgentId,
  spriteState,
  runtimeStatus,
  busy,
  open,
  collapsed = false,
  onToggleCollapsed,
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
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  onSelectAgent: (id: string) => void;
  onCreateAgent: (draft: AgentDraft) => Promise<string | null>;
  onOpenConnectors?: () => void;
  user: SignedInUser;
}) {
  const status = runtimeStatusLabel(runtimeStatus);
  const person = userLabel(user);

  if (collapsed) {
    return (
      <aside className="agent-rail" aria-label="Agents">
        <button
          type="button"
          className="rail-user"
          title={person}
          aria-label={`Expand sidebar, ${person}`}
          onClick={onToggleCollapsed}
        >
          <UserAvatar user={user} />
        </button>
        <div className="rail-divider" role="separator" />
        <div className="rail-agents">
          {agents.map((agent) => {
            const selected = agent.id === activeAgentId;
            return (
              <button
                key={agent.id}
                type="button"
                className={selected ? "rail-agent on" : "rail-agent"}
                title={agent.name}
                aria-label={agent.name}
                aria-current={selected ? "true" : undefined}
                onClick={() => onSelectAgent(agent.id)}
                disabled={busy}
              >
                <BotSprite
                  state={selected ? spriteState : "idle"}
                  color={spriteColorForAgent(agent)}
                  size={28}
                />
              </button>
            );
          })}
        </div>
      </aside>
    );
  }

  return (
    <aside className={open ? "sidebar open" : "sidebar"} aria-label="Agents">
      <div className="side-head">
        <TrafficLights />
        <span className="grow" />
        {onToggleCollapsed ? (
          <button
            type="button"
            className="icon-btn"
            aria-label="Collapse sidebar"
            onClick={onToggleCollapsed}
          >
            <HidePanelIcon />
          </button>
        ) : null}
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
      </footer>
    </aside>
  );
}
