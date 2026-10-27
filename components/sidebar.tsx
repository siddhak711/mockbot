"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { Agent } from "../src/agents/types";
import type { SignedInUser } from "../src/auth/user";
import { UserMenu } from "./user-menu";
import { spriteColorForAgent, type SpriteState } from "../src/sprite";
import { runtimeStatusLabel, type RuntimeStatusView } from "../src/token-stream";
import { AgentPanel, type AgentDraft } from "./agent-panel";
import { BotSprite } from "./bot-sprite";
import {
  AppsIcon,
  ClockIcon,
  CloseIcon,
  HidePanelIcon,
  PlugIcon,
  PlusIcon,
  SearchIcon,
  TrafficLights,
} from "./icons";
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
  runtimeStatus: RuntimeStatusView;
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
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const [formOpen, setFormOpen] = useState(false);

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
        <button
          type="button"
          className={searching ? "round-btn on" : "round-btn"}
          aria-label={searching ? "Close search" : "Search agents"}
          aria-expanded={searching}
          onClick={() => {
            setSearching((value) => !value);
            setQuery("");
          }}
        >
          {searching ? <CloseIcon /> : <SearchIcon size={16} />}
        </button>
        <button
          type="button"
          className="round-btn"
          aria-label="New agent"
          onClick={() => setFormOpen(true)}
          disabled={busy || formOpen}
        >
          <PlusIcon />
        </button>
      </div>
      {searching ? (
        <div className="roster-search">
          <SearchIcon />
          <input
            aria-label="Search agents"
            placeholder="Search agents"
            value={query}
            autoFocus
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setSearching(false);
                setQuery("");
              }
            }}
          />
        </div>
      ) : null}
      <div className="sidebar-sections">
        <AgentPanel
          agents={agents}
          activeAgentId={activeAgentId}
          spriteState={spriteState}
          busy={busy}
          query={query}
          formOpen={formOpen}
          onFormOpenChange={setFormOpen}
          onSelect={onSelectAgent}
          onCreate={onCreateAgent}
        />
      </div>
      <footer className="me" title={status.full}>
        <UserMenu
          user={user}
          detail={status.subtitle ? `${status.title} · ${status.subtitle}` : status.title}
        />
        <AppsMenu onOpenConnectors={onOpenConnectors} />
      </footer>
    </aside>
  );
}

function AppsMenu({ onOpenConnectors }: { onOpenConnectors?: () => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    function onPointer(event: MouseEvent) {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="apps-menu" ref={root}>
      <button
        type="button"
        className="round-btn"
        aria-label="Routines and connectors"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => setOpen((value) => !value)}
      >
        <AppsIcon />
      </button>
      {open ? (
        <div className="menu apps-pop" id={menuId} role="menu" aria-label="Workspace">
          <a className="nav-action" role="menuitem" href="/routines">
            <ClockIcon />
            Routines
          </a>
          {onOpenConnectors ? (
            <button
              type="button"
              className="nav-action"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onOpenConnectors();
              }}
            >
              <PlugIcon />
              Connectors
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
