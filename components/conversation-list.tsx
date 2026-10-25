import type { Agent } from "../src/agents/types";
import { AgentPanel, type AgentDraft } from "./agent-panel";
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
  providerLabel,
  busy,
  open,
  onNew,
  onSelect,
  onSelectAgent,
  onCreateAgent,
}: {
  conversations: Conversation[];
  activeId: string | null;
  agents: Agent[];
  activeAgentId: string;
  providerLabel: string;
  busy: boolean;
  open: boolean;
  onNew: () => void;
  onSelect: (id: string) => void;
  onSelectAgent: (id: string) => void;
  onCreateAgent: (draft: AgentDraft) => Promise<string | null>;
}) {
  const groups = groupsFor(conversations);
  const names = new Map(agents.map((agent) => [agent.id, agent.name]));

  return (
    <aside className={open ? "sidebar open" : "sidebar"}>
      <div className="side-head">
        <span className="logo" aria-hidden="true">
          <svg width="16" height="16" viewBox="0 0 24 24">
            <path
              fill="currentColor"
              d="M12 1.8 14.1 9.9 22.2 12 14.1 14.1 12 22.2 9.9 14.1 1.8 12 9.9 9.9Z"
            />
          </svg>
        </span>
        <span className="product">Mockbot</span>
      </div>
      <button type="button" className="new" onClick={onNew} disabled={busy}>
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          aria-hidden="true"
        >
          <path d="M12 5v14M5 12h14" strokeLinecap="round" />
        </svg>
        New chat
      </button>
      <div className="sidebar-sections">
        <AgentPanel
          agents={agents}
          activeAgentId={activeAgentId}
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
                  {group.items.map((conversation) => (
                    <button
                      key={conversation.id}
                      type="button"
                      className={conversation.id === activeId ? "item on" : "item"}
                      aria-current={conversation.id === activeId ? "true" : undefined}
                      onClick={() => onSelect(conversation.id)}
                      disabled={busy}
                    >
                      {names.get(conversation.agentId)
                        ? `${names.get(conversation.agentId)} · ${conversation.title}`
                        : conversation.title}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>
      <footer className="me">
        <span className="ava" aria-hidden="true">
          M
        </span>
        <span className="me-label">{providerLabel}</span>
      </footer>
    </aside>
  );
}
