import { useState, type ReactNode } from "react";
import type { Agent } from "../src/agents/types";
import type { SignedInUser } from "../src/auth/user";
import { UserMenu } from "./user-menu";
import type { SpriteState } from "../src/sprite";
import { runtimeStatusLabel, type RuntimeStatus } from "../src/token-stream";
import { AgentPanel, type AgentDraft } from "./agent-panel";
import { ClockIcon, ComposeIcon, GearIcon, PlugIcon, TrafficLights } from "./icons";
import { ThemeToggle } from "./theme";
import type { Conversation } from "../src/types";

function dayKey(iso: string): string {
  const date = new Date(iso);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function groupsFor(conversations: Conversation[]): { label: string; items: Conversation[] }[] {
  const today = dayKey(new Date().toISOString());
  const groups = [
    { label: "Today", items: [] as Conversation[] },
    { label: "Earlier", items: [] as Conversation[] },
  ];
  for (const conversation of conversations) {
    if (dayKey(conversation.updatedAt) === today) groups[0].items.push(conversation);
    else groups[1].items.push(conversation);
  }
  return groups.filter((group) => group.items.length > 0);
}

export function ConversationList({
  conversations,
  activeId,
  agents,
  activeAgentId,
  spriteState,
  runtimeStatus,
  busy,
  open,
  onNew,
  onSelect,
  children,
  onSelectAgent,
  onCreateAgent,
  onOpenConnectors,
  user,
}: {
  conversations: Conversation[];
  activeId: string | null;
  agents: Agent[];
  activeAgentId: string;
  spriteState: SpriteState;
  runtimeStatus: RuntimeStatus;
  busy: boolean;
  open: boolean;
  onNew: () => void;
  onSelect: (id: string) => void;
  children?: ReactNode;
  onSelectAgent: (id: string) => void;
  onCreateAgent: (draft: AgentDraft) => Promise<string | null>;
  onOpenConnectors?: () => void;
  user: SignedInUser;
}) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const groups = groupsFor(conversations);
  const names = new Map(agents.map((agent) => [agent.id, agent.name]));
  const status = runtimeStatusLabel(runtimeStatus);

  return (
    <aside className={open ? "sidebar open" : "sidebar"}>
      <div className="side-head">
        <TrafficLights />
        <span className="grow" />
        <ThemeToggle />
      </div>
      <button type="button" className="nav-action" onClick={onNew} disabled={busy}>
        <ComposeIcon />
        New chat
      </button>
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
        <section className="conversation-section" aria-label="Conversations">
          <div className="label">Conversations</div>
          <div className="conversation-scroll">
            {conversations.length === 0 ? <p className="empty">No conversations yet</p> : null}
            {groups.map((group) => (
              <div key={group.label}>
                <div className="label">{group.label}</div>
                <div className="list">
                  {group.items.map((conversation) => {
                    const selected = conversation.id === activeId;
                    const title = names.get(conversation.agentId)
                      ? `${names.get(conversation.agentId)} · ${conversation.title}`
                      : conversation.title;
                    return (
                      <button
                        key={conversation.id}
                        type="button"
                        className={selected ? "item on" : "item"}
                        aria-current={selected ? "true" : undefined}
                        onClick={() => onSelect(conversation.id)}
                        disabled={busy}
                      >
                        <span className="item-dot" aria-hidden="true" />
                        <span className="item-label">{title}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </section>
        {children}
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
              onClick={() => setSettingsOpen((open) => !open)}
            >
              <GearIcon />
            </button>
          </span>
        ) : null}
      </footer>
    </aside>
  );
}
