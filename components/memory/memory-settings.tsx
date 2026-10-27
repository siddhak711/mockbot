"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { Agent } from "../../src/agents/types";
import { replaceMemoryData } from "../../src/memory/panel-store";
import type { Memory, MemoryProposal } from "../../src/types";
import { ThemeToggle } from "../theme";
import { MemoryPanel } from "./memory-panel";
import "./memory.css";

export function MemorySettingsScreen() {
  const router = useRouter();
  const [agentId, setAgentId] = useState<string | null>(null);
  const [agentName, setAgentName] = useState("Mockbot");
  const [ready, setReady] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const stored = window.sessionStorage.getItem("mockbot.memory.agent");
    let cancelled = false;
    void (async () => {
      const response = await fetch("/api/agents");
      if (!response.ok || cancelled) return;
      const data = (await response.json()) as { agents: Agent[] };
      const chosen =
        data.agents.find((agent) => agent.id === stored) ??
        data.agents.find((agent) => agent.isLead) ??
        data.agents[0];
      if (!chosen || cancelled) {
        setReady(true);
        return;
      }
      setAgentId(chosen.id);
      setAgentName(chosen.name);
      setReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!agentId) return;
    let cancelled = false;
    void (async () => {
      const response = await fetch(`/api/memories?agentId=${encodeURIComponent(agentId)}`);
      if (cancelled) return;
      if (!response.ok) {
        replaceMemoryData({ memories: null, proposals: [], error: "Could not load memories" });
        return;
      }
      const data = (await response.json()) as { memories: Memory[]; proposals?: MemoryProposal[] };
      replaceMemoryData({ memories: data.memories, proposals: data.proposals ?? [], error: null });
    })();
    return () => {
      cancelled = true;
    };
  }, [agentId, reload]);

  function back() {
    const stored = window.sessionStorage.getItem("mockbot.memory.return");
    window.sessionStorage.setItem("mockbot.memory.reopen", "1");
    window.sessionStorage.setItem("mockbot.memory.pane", "1");
    const href = stored && stored.startsWith("/") && !stored.startsWith("//") ? stored : "/";
    router.push(href);
  }

  return (
    <div className="memory-ui memory-page">
      <nav className="memory-settings-nav" aria-label="Settings">
        <button type="button" className="memory-back" onClick={back}>
          ← Back to app
        </button>
        <h2>Settings</h2>
        <Link className="nav-item" href="/settings">
          General
        </Link>
        <Link className="nav-item" href="/">
          Agents
        </Link>
        <Link className="nav-item" href="/settings">
          Connectors
        </Link>
        <Link className="nav-item" href="/settings/memory" aria-current="page">
          Memory
        </Link>
        <Link className="nav-item" href="/routines">
          Automations
        </Link>
        <span className="grow" />
        <ThemeToggle />
      </nav>
      <div className="memory-page-main">
        {agentId && ready ? (
          <MemoryPanel
            variant="page"
            agentId={agentId}
            agentName={agentName}
            hotkeys
            onChanged={async () => setReload((current) => current + 1)}
          />
        ) : (
          <p className="memory-count">Loading memory…</p>
        )}
      </div>
    </div>
  );
}
