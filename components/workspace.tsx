"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ConnectorRecord } from "../src/connectors";
import { CommandPalette } from "./command-palette";
import { Composer } from "./composer";
import { connectorForActivity, ConnectorsPanel } from "./connectors-panel";
import { ConversationList } from "./conversation-list";
import { MenuIcon, PlusIcon } from "./icons";
import { ThreadActions } from "./thread-actions";
import { Mochi } from "./mochi";
import { SidePane, type SideTab } from "./side-pane";
import { Transcript } from "./transcript";
import { useRunSprite } from "./use-run-sprite";
import type { AgentDraft } from "./agent-panel";
import { LEAD_AGENT_ID } from "../src/agents/ids";
import type { Agent } from "../src/agents/types";
import type { SignedInUser } from "../src/auth/user";
import { releaseDecision, settleDecision, stopDecision } from "../src/decision-lock";
import { applyMemoryRefresh, memoriesAfterAgentSwitch } from "../src/memory/panel-state";
import { SseParser } from "../src/sse";
import { applyClientEvent, emptyTrace, phaseFromEvent, streamedWeight } from "../src/trace";
import { fetchComputerSnapshot } from "../src/sandbox/refresh";
import type { ComputerSnapshot } from "../src/sandbox/types";
import type { RuntimeStatus } from "../src/token-stream";
import {
  activitiesAfterReconnect,
  activitiesAfterStop,
  activitiesFromMessages,
  describeTool,
  previewText,
  type ToolActivity,
} from "../src/tools/display";
import {
  alertAfterConversationSwitch,
  alertMessageForView,
  spriteLabel,
  type SpriteAlert,
} from "../src/sprite";
import type { Conversation, LivePhase, Memory, Message, ToolCallStatus } from "../src/types";

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function preferRicherAssistant(local: Message[], remote: Message[]): Message[] {
  const localAssistant = [...local].reverse().find((message) => message.role === "assistant");
  const remoteAssistant = [...remote].reverse().find((message) => message.role === "assistant");
  if (streamedWeight(localAssistant) > streamedWeight(remoteAssistant)) return local;
  return remote;
}

function preferredAgentId(agents: Agent[], current: string): string {
  if (agents.some((agent) => agent.id === current)) return current;
  return agents.find((agent) => agent.isLead)?.id ?? agents[0]?.id ?? current;
}

export function Workspace({
  user,
  connectorLaunch,
}: {
  user: SignedInUser;
  connectorLaunch?: { query?: string; preview?: string; intent?: "list" | "add" };
}) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [agentsLoaded, setAgentsLoaded] = useState(false);
  const [activeAgentId, setActiveAgentId] = useState(LEAD_AGENT_ID);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [livePhase, setLivePhase] = useState<LivePhase | null>(null);
  const [alert, setAlert] = useState<SpriteAlert | null>(null);
  const [runtimeStatus, setRuntimeStatus] = useState<RuntimeStatus>({
    provider: "mock",
    model: null,
    database: "local",
  });
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");
  const [computerOpen, setComputerOpen] = useState(true);
  const [sideTab, setSideTab] = useState<SideTab>("computer");
  const [memories, setMemories] = useState<Memory[] | null>(null);
  const [memoryError, setMemoryError] = useState<string | null>(null);
  const [computer, setComputer] = useState<ComputerSnapshot | null>(null);
  const [computerReady, setComputerReady] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [mobilePane, setMobilePane] = useState<"chat" | SideTab>("chat");
  const [activities, setActivities] = useState<ToolActivity[]>([]);
  const [connectors, setConnectors] = useState<ConnectorRecord[]>([]);
  const [connectorsReady, setConnectorsReady] = useState(false);
  const [connectorOpen, setConnectorOpen] = useState(Boolean(connectorLaunch));
  const [connectorIntent, setConnectorIntent] = useState<"list" | "add">(
    connectorLaunch?.intent ?? "list",
  );
  const [connectorQuery, setConnectorQuery] = useState(connectorLaunch?.query ?? "");
  const [connectorPreview] = useState(connectorLaunch?.preview);
  const [pendingReconnectId, setPendingReconnectId] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [composerDraft, setComposerDraft] = useState("");
  const [selectedToolId, setSelectedToolId] = useState<string | null>(null);
  const [decidingId, setDecidingId] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const computerRequest = useRef(0);
  const activeIdRef = useRef<string | null>(null);
  const memoryAgentRef = useRef(LEAD_AGENT_ID);
  const memoriesRef = useRef<Memory[] | null>(null);
  memoriesRef.current = memories;
  const activitiesRef = useRef(activities);
  const decidingRef = useRef<string | null>(null);
  activitiesRef.current = activities;

  const releaseApprovalLock = useCallback(() => {
    stopDecision(decidingRef);
    setDecidingId(null);
  }, []);

  const clearMemoriesForSwitch = useCallback(() => {
    const cleared = memoriesAfterAgentSwitch();
    memoriesRef.current = cleared.memories;
    setMemoryError(cleared.error);
    setMemories(cleared.memories);
  }, []);

  const adoptMemoryAgent = useCallback(
    (agentId: string) => {
      if (memoryAgentRef.current === agentId) return;
      memoryAgentRef.current = agentId;
      clearMemoriesForSwitch();
    },
    [clearMemoriesForSwitch],
  );

  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  const selectConversation = useCallback(
    async (id: string) => {
      const response = await fetch(`/api/conversations/${id}`);
      if (!response.ok) {
        releaseApprovalLock();
        setActiveId(null);
        setMessages([]);
        setActivities([]);
        setSelectedToolId(null);
        return;
      }
      const data = (await response.json()) as { conversation: Conversation; messages: Message[] };
      adoptMemoryAgent(data.conversation.agentId);
      setActiveId(data.conversation.id);
      setActiveAgentId(data.conversation.agentId);
      setMessages(data.messages);
      releaseApprovalLock();
      const nextActivities = activitiesFromMessages(data.messages);
      setActivities(nextActivities);
      setSelectedToolId((current) =>
        current && nextActivities.some((item) => item.id === current)
          ? current
          : (nextActivities[nextActivities.length - 1]?.id ?? null),
      );
      setEditing(false);
      setConversations((prev) =>
        prev.map((item) => (item.id === data.conversation.id ? data.conversation : item)),
      );
      const url = new URL(window.location.href);
      url.searchParams.set("c", data.conversation.id);
      window.history.replaceState(null, "", url);
    },
    [adoptMemoryAgent, releaseApprovalLock],
  );

  const refreshList = useCallback(async () => {
    const response = await fetch("/api/conversations");
    if (!response.ok) return;
    const data = (await response.json()) as { conversations: Conversation[] };
    setConversations(data.conversations);
  }, []);

  const refreshMemories = useCallback(async () => {
    const agentId = memoryAgentRef.current;
    const response = await fetch(`/api/memories?agentId=${encodeURIComponent(agentId)}`);
    const loaded = response.ok
      ? ((await response.json()) as { memories: Memory[] }).memories
      : null;
    const currentAgentId = memoryAgentRef.current;
    if (currentAgentId !== agentId) return;
    const decision = applyMemoryRefresh({
      requestedAgentId: agentId,
      currentAgentId,
      ok: response.ok,
      loaded,
      current: memoriesRef.current,
    });
    if (!decision) return;
    memoriesRef.current = decision.memories;
    setMemoryError(decision.error);
    setMemories(decision.memories);
  }, []);

  const refreshConnectors = useCallback(async () => {
    try {
      const response = await fetch("/api/connectors");
      if (!response.ok) return;
      const data = (await response.json()) as { connectors: ConnectorRecord[] };
      setConnectors(data.connectors);
    } finally {
      setConnectorsReady(true);
    }
  }, []);

  const refreshComputer = useCallback(async () => {
    const request = ++computerRequest.current;
    try {
      const snapshot = await fetchComputerSnapshot(
        (input) => fetch(input),
        request,
        () => computerRequest.current,
      );
      if (!snapshot || request !== computerRequest.current) return;
      setComputer(snapshot);
    } catch {
      // Keep the last snapshot. The pane stays usable if a refresh fails.
    } finally {
      if (request === computerRequest.current) setComputerReady(true);
    }
  }, []);

  const refreshAgents = useCallback(async () => {
    const response = await fetch("/api/agents");
    if (!response.ok) return;
    const data = (await response.json()) as { agents: Agent[] };
    setAgents(data.agents);
    setActiveAgentId((current) => preferredAgentId(data.agents, current));
    setAgentsLoaded(true);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [listResponse, statusResponse, agentResponse] = await Promise.all([
        fetch("/api/conversations"),
        fetch("/api/status"),
        fetch("/api/agents"),
        refreshConnectors(),
      ]);
      if (cancelled) return;
      if (statusResponse.ok) {
        const status = (await statusResponse.json()) as {
          provider: string;
          model: string | null;
          database?: string;
        };
        setRuntimeStatus({
          provider: status.provider,
          model: status.model,
          database: status.database === "neon" ? "neon" : "local",
        });
      }
      if (agentResponse.ok) {
        const agentData = (await agentResponse.json()) as { agents: Agent[] };
        if (!cancelled) {
          setAgents(agentData.agents);
          setActiveAgentId((current) => preferredAgentId(agentData.agents, current));
          setAgentsLoaded(true);
        }
      }
      if (!listResponse.ok) return;
      const data = (await listResponse.json()) as { conversations: Conversation[] };
      if (cancelled) return;
      setConversations(data.conversations);
      const requested = new URLSearchParams(window.location.search).get("c");
      const initial =
        (requested && data.conversations.some((item) => item.id === requested) && requested) ||
        data.conversations[0]?.id;
      if (initial) await selectConversation(initial);
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshConnectors, selectConversation]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const meta = event.metaKey || event.ctrlKey;
      if (!meta) return;
      if (event.shiftKey && event.key.toLowerCase() === "c") {
        event.preventDefault();
        setConnectorIntent("add");
        setConnectorQuery("");
        setConnectorOpen(true);
        return;
      }
      if (!event.shiftKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen(true);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function openConnectors(intent: "list" | "add") {
    setConnectorIntent(intent);
    setConnectorQuery("");
    setConnectorOpen(true);
    setNavOpen(false);
    setPaletteOpen(false);
  }

  function showMemory() {
    setComputerOpen(true);
    setSideTab("memory");
    setMobilePane("memory");
    setNavOpen(false);
    void refreshMemories();
  }

  function showTrace() {
    setComputerOpen(true);
    setSideTab("trace");
    setMobilePane("trace");
    setNavOpen(false);
  }

  useEffect(() => {
    void refreshComputer();
  }, [refreshComputer]);

  function newChat() {
    if (streaming) return;
    setNavOpen(false);
    setMobilePane("chat");
    setActiveId(null);
    setMessages([]);
    setActivities([]);
    setSelectedToolId(null);
    setAlert(null);
    setEditing(false);
    const url = new URL(window.location.href);
    url.searchParams.delete("c");
    window.history.replaceState(null, "", url);
  }

  function selectAgent(id: string) {
    if (streaming) return;
    adoptMemoryAgent(id);
    setActiveAgentId(id);
    newChat();
  }

  async function createAgent(draft: AgentDraft): Promise<string | null> {
    const response = await fetch("/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(draft),
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      return body?.error ?? "Could not create agent";
    }
    await refreshAgents();
    return null;
  }

  async function rename(id: string, title: string) {
    const response = await fetch(`/api/conversations/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      setAlert({
        message: body?.error ?? "Could not rename conversation",
        kind: "workspace",
        ownerId: activeIdRef.current,
      });
      return;
    }
    const data = (await response.json()) as { conversation: Conversation };
    setConversations((prev) => prev.map((item) => (item.id === id ? data.conversation : item)));
    setEditing(false);
  }

  async function remove(id: string) {
    const response = await fetch(`/api/conversations/${id}`, { method: "DELETE" });
    if (!response.ok) {
      setAlert({
        message: "Could not delete conversation",
        kind: "workspace",
        ownerId: activeIdRef.current,
      });
      return;
    }
    setConversations((prev) => prev.filter((item) => item.id !== id));
    if (activeIdRef.current === id) {
      setActiveId(null);
      setMessages([]);
      setActivities([]);
      setSelectedToolId(null);
      setEditing(false);
      const url = new URL(window.location.href);
      url.searchParams.delete("c");
      window.history.replaceState(null, "", url);
    }
  }

  async function reloadKeepingLonger(id: string) {
    releaseApprovalLock();
    const response = await fetch(`/api/conversations/${id}`);
    if (!response.ok) return;
    const data = (await response.json()) as { conversation: Conversation; messages: Message[] };
    setActiveId(data.conversation.id);
    setActiveAgentId(data.conversation.agentId);
    setMessages((local) => preferRicherAssistant(local, data.messages));
    setActivities((local) =>
      activitiesAfterReconnect(local, activitiesFromMessages(data.messages)),
    );
    setConversations((prev) =>
      prev.map((item) => (item.id === data.conversation.id ? data.conversation : item)),
    );
    const url = new URL(window.location.href);
    url.searchParams.set("c", data.conversation.id);
    window.history.replaceState(null, "", url);
  }

  async function send(text: string) {
    const trimmed = text.trim();
    const approvalPending = activitiesRef.current.some((item) => item.state === "approval");
    if (!trimmed || streaming || approvalPending) return;
    setAlert(null);
    setEditing(false);
    const controller = new AbortController();
    abortRef.current = controller;
    setStreaming(true);
    setLivePhase(null);

    const localUserId = `local-${crypto.randomUUID()}`;
    setMessages((prev) => [
      ...prev,
      {
        id: localUserId,
        conversationId: activeIdRef.current ?? "",
        role: "user",
        content: trimmed,
        createdAt: new Date().toISOString(),
        trace: null,
      },
    ]);

    let assistantLocalId: string | null = null;
    let conversationId = activeIdRef.current;
    let sawMeta = false;

    const bindAssistant = (serverId: string) => {
      if (!serverId) return;
      if (!assistantLocalId) assistantLocalId = serverId;
      else if (assistantLocalId !== serverId) {
        const previous = assistantLocalId;
        assistantLocalId = serverId;
        setMessages((prev) =>
          prev.map((item) => (item.id === previous ? { ...item, id: serverId } : item)),
        );
      }
      const id = assistantLocalId;
      const convId = conversationId ?? "";
      setMessages((prev) => {
        if (prev.some((item) => item.id === id)) return prev;
        return [
          ...prev,
          {
            id,
            conversationId: convId,
            role: "assistant",
            content: "",
            createdAt: new Date().toISOString(),
            trace: emptyTrace(),
          },
        ];
      });
    };

    const applyStream = (name: string, payload: Record<string, unknown>) => {
      const phase = phaseFromEvent(name);
      if (phase) setLivePhase(phase);
      if (!assistantLocalId) assistantLocalId = `local-${crypto.randomUUID()}`;
      const assistantId = assistantLocalId;
      const convId = conversationId ?? "";
      setMessages((prev) => {
        const index = prev.findIndex((item) => item.id === assistantId);
        if (index === -1) {
          return [
            ...prev,
            applyClientEvent(
              {
                id: assistantId,
                conversationId: convId,
                role: "assistant",
                content: "",
                createdAt: new Date().toISOString(),
                trace: emptyTrace(),
              },
              name,
              payload,
            ),
          ];
        }
        const next = prev.slice();
        const current = prev[index];
        if (!current) return prev;
        next[index] = applyClientEvent(current, name, payload);
        return next;
      });
    };

    const patchActivity = (id: string, patch: Partial<ToolActivity>) => {
      setActivities((prev) => prev.map((item) => (item.id === id ? { ...item, ...patch } : item)));
    };

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: trimmed,
          conversationId: conversationId ?? undefined,
          agentId: conversationId ? undefined : activeAgentId,
        }),
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? "Request failed");
      }

      const parser = new SseParser();
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const event of parser.push(decoder.decode(value, { stream: true }))) {
          const payload = JSON.parse(event.data) as Record<string, unknown>;
          if (event.event === "meta") {
            sawMeta = true;
            conversationId = String(payload.conversationId);
            const title = String(payload.title);
            setActiveId(conversationId);
            const url = new URL(window.location.href);
            url.searchParams.set("c", conversationId);
            window.history.replaceState(null, "", url);
            const id = conversationId;
            setConversations((prev) => {
              const others = prev.filter((item) => item.id !== id);
              const now = new Date().toISOString();
              return [
                { id, title, agentId: activeAgentId, createdAt: now, updatedAt: now },
                ...others,
              ];
            });
            setMessages((prev) =>
              prev.map((item) =>
                item.id === localUserId ? { ...item, conversationId: id } : item,
              ),
            );
          } else if (
            event.event === "prompt" ||
            event.event === "start" ||
            event.event === "reasoning" ||
            event.event === "tool_call" ||
            event.event === "delta" ||
            event.event === "end" ||
            (event.event === "tool_result" &&
              typeof payload.content === "string" &&
              typeof payload.status !== "string")
          ) {
            applyStream(event.event, payload);
          } else if (event.event === "tool_start") {
            const id = String(payload.id ?? "");
            const name = String(payload.name ?? "");
            const messageId = String(payload.assistantMessageId ?? "");
            if (!id || !messageId) continue;
            bindAssistant(messageId);
            const described = describeTool(name, "");
            setActivities((prev) => [
              ...prev.filter((item) => item.id !== id),
              {
                id,
                messageId,
                name,
                arguments: "",
                output: "",
                preview: "",
                state: "running",
                ...described,
              },
            ]);
            setSelectedToolId(id);
          } else if (event.event === "tool_args") {
            const id = String(payload.id ?? "");
            const raw = String(payload.arguments ?? "");
            setActivities((prev) =>
              prev.map((item) => {
                if (item.id !== id) return item;
                return { ...item, arguments: raw, ...describeTool(item.name, raw) };
              }),
            );
          } else if (event.event === "approval_required") {
            const id = String(payload.id ?? "");
            const raw = String(payload.arguments ?? "");
            const summary = String(payload.summary ?? "");
            setActivities((prev) =>
              prev.map((item) => {
                if (item.id !== id) return item;
                const described = describeTool(item.name, raw || item.arguments);
                return {
                  ...item,
                  ...described,
                  state: "approval",
                  arguments: raw || item.arguments,
                  summary: summary || described.summary,
                };
              }),
            );
            setSelectedToolId(id);
          } else if (event.event === "tool_status") {
            const id = String(payload.id ?? "");
            const status = String(payload.status ?? "") as ToolCallStatus;
            if (!id || !status) continue;
            patchActivity(id, { state: status });
            if (status !== "approval") {
              releaseDecision(decidingRef, id);
              setDecidingId((current) => (current === id ? null : current));
            }
          } else if (event.event === "tool_result") {
            const id = String(payload.id ?? "");
            const status = String(payload.status ?? "done") as ToolCallStatus;
            const output = String(payload.output ?? "");
            const title = typeof payload.title === "string" ? payload.title : undefined;
            patchActivity(id, {
              state: status,
              output,
              preview: output ? previewText(output) : "",
              ...(title ? { title } : {}),
            });
            void refreshComputer();
            releaseDecision(decidingRef, id);
            setDecidingId((current) => (current === id ? null : current));
          } else if (event.event === "error") {
            setAlert({
              message: String(payload.message ?? "The model request failed"),
              kind: "turn",
              ownerId: conversationId,
            });
          }
        }
      }

      if (conversationId) {
        await selectConversation(conversationId);
        await refreshList();
        await refreshMemories();
      }
    } catch (sendError) {
      if (isAbort(sendError)) {
        if (conversationId && sawMeta) {
          await wait(200);
          await reloadKeepingLonger(conversationId);
          await refreshList();
        }
      } else {
        if (!sawMeta) {
          setMessages((prev) =>
            prev.filter((item) => item.id !== localUserId && item.id !== assistantLocalId),
          );
        }
        setAlert({
          message: sendError instanceof Error ? sendError.message : "Something went wrong",
          kind: "turn",
          ownerId: conversationId,
        });
      }
    } finally {
      setStreaming(false);
      setLivePhase(null);
      abortRef.current = null;
      void refreshComputer();
      void refreshConnectors();
    }
  }

  async function decide(id: string, decision: "approve" | "deny") {
    try {
      const outcome = await settleDecision(decidingRef, id, async () => {
        setDecidingId(id);
        const response = await fetch("/api/tools/approvals", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, decision }),
        });
        if (response.ok) {
          setActivities((prev) =>
            prev.map((item) =>
              item.id === id
                ? { ...item, state: decision === "approve" ? "running" : "denied" }
                : item,
            ),
          );
          return true;
        }
        const activity = activitiesRef.current.find((item) => item.id === id);
        if (!activity || activity.state === "approval") {
          setAlert({
            message:
              response.status === 404
                ? "That approval expired. Send the request again."
                : "Could not save the decision",
            kind: "workspace",
            ownerId: activeIdRef.current,
          });
        }
        return false;
      });
      if (outcome === "released") {
        setDecidingId((current) => (current === id ? null : current));
      }
    } catch {
      setDecidingId((current) => (current === id ? null : current));
    }
  }

  function stopTurn() {
    const pending = activitiesRef.current.filter((activity) => activity.state === "approval");
    if (pending.length > 0) setActivities((current) => activitiesAfterStop(current));
    abortRef.current?.abort();
    stopDecision(decidingRef);
    setDecidingId(null);
    for (const activity of pending) {
      void fetch("/api/tools/approvals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: activity.id, decision: "stop" }),
      });
    }
  }

  const active = conversations.find((item) => item.id === activeId) ?? null;
  const computerStatus = computerReady ? (computer ? "ready" : "error") : "loading";
  const speakingId = active?.agentId ?? activeAgentId;
  const speaking = agents.find((agent) => agent.id === speakingId) ?? null;
  const awaitingApproval = activities.some((activity) => activity.state === "approval");
  const error = alertMessageForView(alert, activeId);
  const sprite = useRunSprite({
    conversationId: activeId,
    streaming,
    livePhase,
    alert,
    messages,
    activities,
  });

  useEffect(() => {
    if (!agentsLoaded) return;
    if (memoryAgentRef.current !== speakingId) {
      memoryAgentRef.current = speakingId;
      clearMemoriesForSwitch();
    }
    void refreshMemories();
  }, [agentsLoaded, speakingId, refreshMemories, clearMemoriesForSwitch]);

  return (
    <div className={computerOpen ? "app with-computer" : "app"}>
      <ConversationList
        conversations={conversations}
        activeId={activeId}
        agents={agents}
        activeAgentId={speakingId}
        spriteState={sprite}
        runtimeStatus={runtimeStatus}
        busy={streaming}
        open={navOpen}
        onNew={newChat}
        onSelect={(id) => {
          setNavOpen(false);
          setMobilePane("chat");
          if (!streaming) {
            if (id !== activeId) setAlert((current) => alertAfterConversationSwitch(current));
            void selectConversation(id);
          }
        }}
        onSelectAgent={selectAgent}
        onCreateAgent={createAgent}
        onOpenConnectors={() => openConnectors("list")}
        user={user}
      ></ConversationList>
      <button
        type="button"
        className={navOpen ? "scrim on" : "scrim"}
        aria-label="Close conversations"
        tabIndex={navOpen ? 0 : -1}
        onClick={() => setNavOpen(false)}
      />
      <main className={mobilePane === "chat" ? "main pane-chat" : "main pane-side"}>
        <header className="top">
          <button
            type="button"
            className="icon-btn"
            aria-label="Open conversations"
            aria-expanded={navOpen}
            onClick={() => setNavOpen(true)}
          >
            <MenuIcon />
          </button>
          <h1>{active?.title ?? "New chat"}</h1>
          <button
            type="button"
            className="icon-btn"
            aria-label="New chat"
            onClick={newChat}
            disabled={streaming}
          >
            <PlusIcon />
          </button>
        </header>
        <div className="segments" role="tablist" aria-label="Workspace">
          <button
            type="button"
            role="tab"
            aria-selected={mobilePane === "chat"}
            className={mobilePane === "chat" ? "on" : undefined}
            onClick={() => setMobilePane("chat")}
          >
            Chat
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mobilePane === "computer"}
            className={mobilePane === "computer" ? "on" : undefined}
            onClick={() => {
              setSideTab("computer");
              setMobilePane("computer");
            }}
          >
            Computer
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mobilePane === "memory"}
            className={mobilePane === "memory" ? "on" : undefined}
            onClick={() => showMemory()}
          >
            Memory
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mobilePane === "trace"}
            className={mobilePane === "trace" ? "on" : undefined}
            onClick={() => showTrace()}
          >
            Trace
          </button>
        </div>
        <header className="thread-header">
          {editing && active ? (
            <form
              className="rename-form"
              onSubmit={(event) => {
                event.preventDefault();
                const title = draftTitle.trim();
                if (title) void rename(active.id, title);
              }}
            >
              <input
                aria-label="Conversation title"
                value={draftTitle}
                onChange={(event) => setDraftTitle(event.target.value)}
                autoFocus
              />
              <button type="submit" className="ghost-text">
                Save
              </button>
              <button type="button" className="ghost-text" onClick={() => setEditing(false)}>
                Cancel
              </button>
            </form>
          ) : (
            <>
              <h1>
                <Mochi state={sprite} size={24} label={`Mochi, ${spriteLabel(sprite)}`} />
                <span className="thread-title">{active?.title ?? "New chat"}</span>
              </h1>
              {speaking ? <span className="agent-chip">{speaking.name}</span> : null}
              <ThreadActions
                active={active}
                streaming={streaming}
                computerOpen={computerOpen}
                onRename={() => {
                  if (!active) return;
                  setDraftTitle(active.title);
                  setEditing(true);
                }}
                onDelete={() => {
                  if (!active) return;
                  void remove(active.id);
                }}
                onMemory={showMemory}
                onShowComputer={() => setComputerOpen(true)}
              />
            </>
          )}
        </header>
        <div className="chat-body">
          <Transcript
            messages={messages}
            streaming={streaming}
            livePhase={livePhase}
            spriteState={sprite}
            activities={activities}
            decidingId={decidingId}
            onDecide={(id, decision) => void decide(id, decision)}
            onSelectTool={setSelectedToolId}
            onOpenTrace={showTrace}
            reconnectFor={(activity) => {
              if (activity.state !== "error") return null;
              const connector = connectorForActivity(connectors, activity.name);
              if (!connector || connector.status !== "reconnect") return null;
              return connector.name;
            }}
            onReconnect={(activity) => {
              const connector = connectorForActivity(connectors, activity.name);
              if (!connector) return;
              setPendingReconnectId(connector.id);
              setConnectorIntent("list");
              setConnectorOpen(true);
            }}
          />
          {error ? (
            <p className="error" role="alert">
              {error}
            </p>
          ) : null}
          <Composer
            streaming={streaming}
            awaitingApproval={awaitingApproval}
            placeholder={speaking ? `Message ${speaking.name}` : "Message Mockbot"}
            value={composerDraft}
            onValueChange={setComposerDraft}
            onAddConnector={() => openConnectors("add")}
            onSend={(text) => void send(text)}
            onStop={stopTurn}
          />
        </div>
        <div className="computer-sheet">
          <SidePane
            tab={mobilePane === "chat" ? sideTab : mobilePane}
            onTab={(tab) => {
              setSideTab(tab);
              setMobilePane(tab);
            }}
            memories={memories}
            memoryError={memoryError}
            agentId={speakingId}
            onMemoriesChanged={refreshMemories}
            activities={activities}
            selectedId={selectedToolId}
            onSelect={setSelectedToolId}
            snapshot={computer}
            status={computerStatus}
            messages={messages}
          />
        </div>
      </main>
      {computerOpen ? (
        <SidePane
          tab={sideTab}
          onTab={setSideTab}
          onHide={() => setComputerOpen(false)}
          memories={memories}
          memoryError={memoryError}
          agentId={speakingId}
          onMemoriesChanged={refreshMemories}
          activities={activities}
          selectedId={selectedToolId}
          onSelect={setSelectedToolId}
          snapshot={computer}
          status={computerStatus}
          messages={messages}
        />
      ) : null}
      <ConnectorsPanel
        open={connectorOpen}
        intent={connectorIntent}
        connectors={connectors}
        ready={connectorsReady}
        initialQuery={connectorQuery}
        preview={connectorPreview}
        pendingReconnectId={pendingReconnectId}
        onReconnectStarted={() => setPendingReconnectId(null)}
        onClose={() => setConnectorOpen(false)}
        onChanged={refreshConnectors}
        onInsertPrompt={(text) => setComposerDraft(text)}
        onStop={stopTurn}
      />
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        commands={[
          { id: "connectors", label: "Connectors", run: () => openConnectors("list") },
          { id: "add-connector", label: "Add connector", run: () => openConnectors("add") },
          {
            id: "new-chat",
            label: "New chat",
            run: () => {
              setPaletteOpen(false);
              newChat();
            },
          },
          {
            id: "routines",
            label: "Routines",
            run: () => {
              window.location.assign("/routines");
            },
          },
        ]}
      />
    </div>
  );
}
