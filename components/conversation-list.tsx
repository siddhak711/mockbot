import type { Conversation } from "../src/types";

export function ConversationList({
  conversations,
  activeId,
  providerLabel,
  busy,
  onNew,
  onSelect,
}: {
  conversations: Conversation[];
  activeId: string | null;
  providerLabel: string;
  busy: boolean;
  onNew: () => void;
  onSelect: (id: string) => void;
}) {
  return (
    <aside className="sidebar">
      <div className="sidebar-top">
        <div className="brand">Mockbot</div>
        <button type="button" className="primary" onClick={onNew} disabled={busy}>
          New chat
        </button>
      </div>
      <ul className="conversation-list">
        {conversations.length === 0 ? <li className="empty">No conversations yet</li> : null}
        {conversations.map((conversation) => (
          <li key={conversation.id} className={conversation.id === activeId ? "active" : ""}>
            <button
              type="button"
              className="conversation-title"
              aria-current={conversation.id === activeId ? "true" : undefined}
              onClick={() => onSelect(conversation.id)}
              disabled={busy}
            >
              {conversation.title}
            </button>
          </li>
        ))}
      </ul>
      <footer className="provider-label">{providerLabel}</footer>
    </aside>
  );
}
