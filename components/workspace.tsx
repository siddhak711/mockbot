"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import type { ConnectorRecord } from "../src/connectors";
import { CommandPalette } from "./command-palette";
import { Composer } from "./composer";
import { connectorForActivity, ConnectorsPanel } from "./connectors-panel";
import { MenuIcon } from "./icons";
import { Sidebar } from "./sidebar";
import { ThreadActions } from "./thread-actions";
import { BotSprite, botSpriteLabel } from "./bot-sprite";
import { PANE_WIDTH_DEFAULT, widthForContentTab, type ComputerContentTab } from "./computer-pane";
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
import {
  applyClientEvent,
  emptyTrace,
  phaseFromEvent,
  phaseFromTrace,
  streamedWeight,
} from "../src/trace";
import { ComputerUnavailableError, fetchComputerSnapshot } from "../src/sandbox/refresh";
import type { ComputerSnapshot } from "../src/sandbox/types";
import type { RuntimeStatus } from "../src/token-stream";
import {
  activitiesAfterReconnect,
  activitiesAfterStop,
  activitiesFromMessages,
  resumeProgress,
  describeTool,
  previewText,
  type ToolActivity,
} from "../src/tools/display";
import {
  alertAfterConversationSwitch,
  alertMessageForView,
  spriteColorForAgent,
  type SpriteAlert,
} from "../src/sprite";
import type { Conversation, LivePhase, Memory, Message, ToolCallStatus } from "../src/types";

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

const RESUME_POLL_MS = 500;
/** How often a reloaded page re-reads a reply that is still generating. */
const LIVE_POLL_MS = 400;
/** About ten minutes, the longest a resumed turn's tools may run. */
const RESUME_POLL_ATTEMPTS = 1200;

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
  const [active, setActive] = useState<Conversation | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [agentsLoaded, setAgentsLoaded] = useState(false);
  const [activeAgentId, setActiveAgentId] = useState(LEAD_AGENT_ID);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [streaming, setStreaming] = useState(false);
  // A paused turn running again after a decision made with no live stream.
  const [resuming, setResuming] = useState(false);
  /** A conversation whose reply kept generating on the server after this page loaded. */
  const [followId, setFollowId] = useState<string | null>(null);
  const resumingRef = useRef(false);
  const [livePhase, setLivePhase] = useState<LivePhase | null>(null);
  const [alert, setAlert] = useState<SpriteAlert | null>(null);
  const [runtimeStatus, setRuntimeStatus] = useState<RuntimeStatus>({
    provider: "mock",
    model: null,
    database: "local",
  });
  const [computerOpen, setComputerOpen] = useState(true);
  const [computerPopped, setComputerPopped] = useState(false);
  const [paneWidth, setPaneWidth] = useState(PANE_WIDTH_DEFAULT);
  const [sideTab, setSideTab] = useState<SideTab>("computer");
  const [memories, setMemories] = useState<Memory[] | null>(null);
  const [memoryError, setMemoryError] = useState<string | null>(null);
  const [computer, setComputer] = useState<ComputerSnapshot | null>(null);
  // Why the server has no sandbox, from its 503 body.
  const [computerError, setComputerError] = useState<string | null>(null);
  const [computerReady, setComputerReady] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
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
  const [decidingId, setDecidingId] = useState<string | null>(null);
  const [replayIds, setReplayIds] = useState<Record<string, string>>({});
  const abortRef = useRef<AbortController | null>(null);
  const computerRequest = useRef(0);
  // The agent whose sandbox the computer pane shows.
  const computerAgentRef = useRef(LEAD_AGENT_ID);
  const agentLoadRequest = useRef(0);
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

  const applyThread = useCallback(
    (conversation: Conversation, thread: Message[], query: "agent" | "c") => {
      adoptMemoryAgent(conversation.agentId);
      setActive(conversation);
      setActiveId(conversation.id);
      setActiveAgentId(conversation.agentId);
      setMessages(thread);
      releaseApprovalLock();
      setActivities(activitiesFromMessages(thread));
      const url = new URL(window.location.href);
      if (query === "agent") {
        url.searchParams.set("agent", conversation.agentId);
        url.searchParams.delete("c");
      } else {
        url.searchParams.set("c", conversation.id);
      }
      window.history.replaceState(null, "", url);
    },
    [adoptMemoryAgent, releaseApprovalLock],
  );

  const selectConversation = useCallback(
    async (id: string): Promise<boolean> => {
      const response = await fetch(`/api/conversations/${id}`);
      if (!response.ok) return false;
      const data = (await response.json()) as {
        conversation: Conversation;
        messages: Message[];
        running?: boolean;
      };
      applyThread(data.conversation, data.messages, "c");
      if (data.running && !abortRef.current) setFollowId(data.conversation.id);
      return true;
    },
    [applyThread],
  );

  const loadAgentConversation = useCallback(
    async (agentId: string) => {
      const request = ++agentLoadRequest.current;
      const response = await fetch(`/api/agents/${encodeURIComponent(agentId)}/conversation`);
      if (request !== agentLoadRequest.current) return;
      if (!response.ok) {
        releaseApprovalLock();
        setActive(null);
        setActiveId(null);
        setMessages([]);
        setActivities([]);
        return;
      }
      const data = (await response.json()) as {
        conversation: Conversation;
        messages: Message[];
        running?: boolean;
      };
      if (request !== agentLoadRequest.current) return;
      applyThread(data.conversation, data.messages, "agent");
      if (data.running && !abortRef.current) setFollowId(data.conversation.id);
    },
    [applyThread, releaseApprovalLock],
  );

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
        computerAgentRef.current,
      );
      if (!snapshot || request !== computerRequest.current) return;
      setComputer(snapshot);
      setComputerError(null);
    } catch (error) {
      // Keep the last snapshot. The pane stays usable if a refresh fails.
      if (error instanceof ComputerUnavailableError && request === computerRequest.current) {
        setComputerError(error.message || null);
      }
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
      const [statusResponse, agentResponse] = await Promise.all([
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
      if (!agentResponse.ok) return;
      const agentData = (await agentResponse.json()) as { agents: Agent[] };
      if (cancelled) return;
      setAgents(agentData.agents);
      setAgentsLoaded(true);
      const params = new URLSearchParams(window.location.search);
      const requestedConversation = params.get("c");
      if (requestedConversation) {
        const found = await selectConversation(requestedConversation);
        if (cancelled || found) return;
      }
      const requestedAgent = params.get("agent");
      const agentId = preferredAgentId(agentData.agents, requestedAgent ?? LEAD_AGENT_ID);
      setActiveAgentId(agentId);
      await loadAgentConversation(agentId);
    })();
    return () => {
      cancelled = true;
    };
  }, [loadAgentConversation, refreshConnectors, selectConversation]);

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

  function selectAgent(id: string) {
    if (streaming) return;
    setNavOpen(false);
    setMobilePane("chat");
    setAlert((current) => alertAfterConversationSwitch(current));
    adoptMemoryAgent(id);
    setActiveAgentId(id);
    activeIdRef.current = null;
    setActiveId(null);
    void loadAgentConversation(id);
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

  // After a reload mid-reply the server is still generating. Lock the composer,
  // show Stop, and re-read the thread until the turn ends.
  useEffect(() => {
    if (!followId) return;
    const id = followId;
    let cancelled = false;
    setStreaming(true);
    void (async () => {
      let finished = false;
      try {
        while (!cancelled) {
          await wait(LIVE_POLL_MS);
          if (cancelled || activeIdRef.current !== id) return;
          const response = await fetch(`/api/conversations/${id}`);
          if (cancelled || activeIdRef.current !== id) return;
          if (!response.ok) return;
          const data = (await response.json()) as {
            conversation: Conversation;
            messages: Message[];
            running?: boolean;
          };
          if (cancelled || activeIdRef.current !== id) return;
          setMessages(data.messages);
          setActivities(activitiesFromMessages(data.messages));
          const last = data.messages.at(-1);
          setLivePhase(last?.role === "assistant" ? phaseFromTrace(last.trace) : "start");
          if (!data.running) {
            finished = true;
            return;
          }
        }
      } finally {
        if (!cancelled) {
          setStreaming(false);
          setLivePhase(null);
          setFollowId(null);
          if (finished) {
            void refreshAgents();
            void refreshMemories();
            void refreshComputer();
          }
        }
      }
    })();
    return () => {
      cancelled = true;
      setStreaming(false);
      setLivePhase(null);
    };
  }, [followId, refreshAgents, refreshMemories, refreshComputer]);

  async function reloadKeepingLonger(id: string) {
    releaseApprovalLock();
    const response = await fetch(`/api/conversations/${id}`);
    if (!response.ok) return;
    const data = (await response.json()) as { conversation: Conversation; messages: Message[] };
    setActive(data.conversation);
    setActiveId(data.conversation.id);
    setActiveAgentId(data.conversation.agentId);
    setMessages((local) => preferRicherAssistant(local, data.messages));
    setActivities((local) =>
      activitiesAfterReconnect(local, activitiesFromMessages(data.messages)),
    );
    const url = new URL(window.location.href);
    url.searchParams.set("c", data.conversation.id);
    window.history.replaceState(null, "", url);
  }

  async function send(text: string, options?: { plan?: boolean }) {
    const trimmed = text.trim();
    const approvalPending = activitiesRef.current.some(
      (item) => item.state === "approval" || item.state === "ask" || item.state === "plan",
    );
    if (!trimmed || streaming || resumingRef.current || approvalPending) return;
    agentLoadRequest.current += 1;
    setAlert(null);
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
          agentId: activeAgentId,
          ...(options?.plan ? { plan: true } : {}),
          // Keep generating if this page reloads. Stop goes through /api/chat/stop.
          detach: true,
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
            url.searchParams.set("agent", activeAgentId);
            url.searchParams.delete("c");
            window.history.replaceState(null, "", url);
            const id = conversationId;
            const now = new Date().toISOString();
            setActive({
              id,
              title,
              agentId: activeAgentId,
              createdAt: now,
              updatedAt: now,
            });
            setMessages((prev) =>
              prev.map((item) =>
                item.id === localUserId ? { ...item, conversationId: id } : item,
              ),
            );
            if (typeof payload.runId === "string" && payload.runId) {
              const replayRunId = payload.runId;
              setReplayIds((prev) => ({ ...prev, [id]: replayRunId }));
            }
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
          } else if (event.event === "tool_args") {
            const id = String(payload.id ?? "");
            const raw = String(payload.arguments ?? "");
            setActivities((prev) =>
              prev.map((item) => {
                if (item.id !== id) return item;
                return { ...item, arguments: raw, ...describeTool(item.name, raw) };
              }),
            );
          } else if (event.event === "plan_required" || event.event === "plan_progress") {
            const id = String(payload.id ?? "");
            const messageId = String(payload.assistantMessageId ?? "");
            if (messageId) bindAssistant(messageId);
            const steps = Array.isArray(payload.steps) ? payload.steps : [];
            const raw =
              typeof payload.arguments === "string" ? payload.arguments : JSON.stringify({ steps });
            const described = describeTool("propose_plan", raw);
            const status = (
              event.event === "plan_required" ? "plan" : String(payload.status ?? "running")
            ) as ToolCallStatus;
            if (!id) continue;
            setActivities((prev) => {
              const existing = prev.find((item) => item.id === id);
              const next = {
                id,
                messageId: messageId || existing?.messageId || "",
                name: "propose_plan",
                arguments: raw,
                output: existing?.output ?? "",
                preview: existing?.preview ?? "",
                state: status,
                ...described,
              };
              return [...prev.filter((item) => item.id !== id), next];
            });
            if (status !== "plan") {
              releaseDecision(decidingRef, id);
              setDecidingId((current) => (current === id ? null : current));
            }
          } else if (event.event === "ask_user") {
            const id = String(payload.id ?? "");
            const raw = String(payload.arguments ?? "");
            const question = String(payload.question ?? "");
            setActivities((prev) =>
              prev.map((item) => {
                if (item.id !== id) return item;
                const described = describeTool(item.name, raw || item.arguments);
                return {
                  ...item,
                  ...described,
                  state: "ask",
                  arguments: raw || item.arguments,
                  summary: question || described.summary,
                  title: question || described.title,
                };
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
        await refreshMemories();
        void refreshAgents();
      }
    } catch (sendError) {
      if (isAbort(sendError)) {
        if (conversationId && sawMeta) {
          await wait(200);
          await reloadKeepingLonger(conversationId);
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
    const live = abortRef.current !== null;
    let saved = false;
    try {
      const outcome = await settleDecision(decidingRef, id, async () => {
        setDecidingId(id);
        const response = await fetch("/api/tools/approvals", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, decision }),
        });
        if (response.ok) {
          saved = true;
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
      const conversationId = activeIdRef.current;
      if (saved && !live && conversationId) await watchResume(conversationId, id);
    } catch {
      setDecidingId((current) => (current === id ? null : current));
    }
  }

  async function decidePlan(
    id: string,
    action:
      { type: "approve"; steps?: unknown } | { type: "edit"; steps: unknown } | { type: "cancel" },
  ) {
    const live = abortRef.current !== null;
    let saved = false;
    try {
      const outcome = await settleDecision(decidingRef, id, async () => {
        setDecidingId(id);
        const response = await fetch("/api/tools/plans", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id,
            decision: action.type === "cancel" ? "cancel" : action.type,
            ...("steps" in action && action.steps ? { steps: action.steps } : {}),
          }),
        });
        if (response.ok) {
          saved = action.type !== "edit";
          const body = (await response.json().catch(() => null)) as { steps?: unknown } | null;
          if (action.type === "edit" || (action.type === "approve" && body?.steps)) {
            const raw = JSON.stringify({
              steps: body?.steps ?? ("steps" in action ? action.steps : []),
            });
            const described = describeTool("propose_plan", raw);
            setActivities((prev) =>
              prev.map((item) =>
                item.id === id
                  ? {
                      ...item,
                      ...described,
                      arguments: raw,
                      state: action.type === "approve" ? "running" : "plan",
                    }
                  : item,
              ),
            );
          } else if (action.type === "approve") {
            setActivities((prev) =>
              prev.map((item) => (item.id === id ? { ...item, state: "running" } : item)),
            );
          } else {
            setActivities((prev) =>
              prev.map((item) =>
                item.id === id
                  ? { ...item, state: "denied", output: "Plan cancelled. Nothing ran." }
                  : item,
              ),
            );
          }
          return true;
        }
        const activity = activitiesRef.current.find((item) => item.id === id);
        if (!activity || activity.state === "plan") {
          const body = (await response.json().catch(() => null)) as { error?: string } | null;
          setAlert({
            message:
              body?.error ??
              (response.status === 404
                ? "That plan expired. Send the request again."
                : "Could not save the plan"),
            kind: "workspace",
            ownerId: activeIdRef.current,
          });
        }
        return false;
      });
      if (outcome === "released") {
        setDecidingId((current) => (current === id ? null : current));
      }
      const conversationId = activeIdRef.current;
      if (saved && !live && conversationId) await watchPlan(conversationId, id);
    } catch {
      setDecidingId((current) => (current === id ? null : current));
    }
  }

  async function watchPlan(conversationId: string, toolId: string) {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      await wait(200);
      if (activeIdRef.current !== conversationId) return;
      const response = await fetch(`/api/conversations/${conversationId}`);
      if (!response.ok) continue;
      const data = (await response.json()) as { conversation: Conversation; messages: Message[] };
      if (activeIdRef.current !== conversationId) return;
      setMessages(data.messages);
      const next = activitiesFromMessages(data.messages);
      setActivities(next);
      const tool = next.find((item) => item.id === toolId);
      if (!tool || (tool.state !== "plan" && tool.state !== "running")) return;
    }
  }

  async function answer(id: string, text: string) {
    const live = abortRef.current !== null;
    let saved = false;
    try {
      const outcome = await settleDecision(decidingRef, id, async () => {
        setDecidingId(id);
        const response = await fetch("/api/tools/asks", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, answer: text }),
        });
        if (response.ok) {
          saved = true;
          setActivities((prev) =>
            prev.map((item) => (item.id === id ? { ...item, state: "running" } : item)),
          );
          return true;
        }
        const activity = activitiesRef.current.find((item) => item.id === id);
        if (!activity || activity.state === "ask") {
          const body = (await response.json().catch(() => null)) as { error?: string } | null;
          setAlert({
            message:
              body?.error ??
              (response.status === 404
                ? "That question expired. Send the request again."
                : "Could not save the answer"),
            kind: "workspace",
            ownerId: activeIdRef.current,
          });
        }
        return false;
      });
      if (outcome === "released") {
        setDecidingId((current) => (current === id ? null : current));
      }
      const conversationId = activeIdRef.current;
      if (saved && !live && conversationId) await watchResume(conversationId, id);
    } catch {
      setDecidingId((current) => (current === id ? null : current));
    }
  }

  /**
   * Follow a turn that continues on the server after a decision. Keep the
   * composer locked and poll until the turn ends or pauses for the person again.
   */
  async function watchResume(conversationId: string, toolId: string) {
    resumingRef.current = true;
    setResuming(true);
    try {
      for (let attempt = 0; attempt < RESUME_POLL_ATTEMPTS; attempt += 1) {
        const response = await fetch(`/api/conversations/${conversationId}`);
        if (activeIdRef.current !== conversationId) return;
        if (response.ok) {
          const data = (await response.json()) as {
            conversation: Conversation;
            messages: Message[];
          };
          if (activeIdRef.current !== conversationId) return;
          setMessages(data.messages);
          setActivities(activitiesFromMessages(data.messages));
          if (resumeProgress(data.messages, toolId) !== "running") return;
        }
        await wait(RESUME_POLL_MS);
      }
    } finally {
      resumingRef.current = false;
      setResuming(false);
    }
  }

  function stopTurn() {
    const pending = activitiesRef.current.filter(
      (activity) =>
        activity.state === "approval" || activity.state === "ask" || activity.state === "plan",
    );
    if (pending.length > 0) setActivities((current) => activitiesAfterStop(current));
    const conversationId = activeIdRef.current;
    if (conversationId) {
      void fetch("/api/chat/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId }),
      });
    }
    abortRef.current?.abort();
    stopDecision(decidingRef);
    setDecidingId(null);
    for (const activity of pending) {
      const path =
        activity.state === "ask"
          ? "/api/tools/asks"
          : activity.state === "plan"
            ? "/api/tools/plans"
            : "/api/tools/approvals";
      void fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: activity.id,
          decision: activity.state === "plan" ? "cancel" : "stop",
        }),
      });
    }
  }

  const computerStatus = computerReady ? (computer ? "ready" : "error") : "loading";
  const computerDocked = computerOpen && !computerPopped;
  function chooseComputerTab(tab: ComputerContentTab) {
    setPaneWidth((current) => widthForContentTab(current, tab));
  }
  function hideComputer() {
    setComputerPopped(false);
    setComputerOpen(false);
  }
  const speakingId = active?.agentId ?? activeAgentId;
  useEffect(() => {
    if (computerAgentRef.current === speakingId) return;
    computerAgentRef.current = speakingId;
    void refreshComputer();
  }, [speakingId, refreshComputer]);
  const speaking = agents.find((agent) => agent.id === speakingId) ?? null;
  const spriteColor = spriteColorForAgent(speaking);
  const spriteName = speaking?.name ?? "Mockbot";
  const awaitingAsk = activities.some((activity) => activity.state === "ask");
  const awaitingPlan = activities.some((activity) => activity.state === "plan");
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
    <div
      className={[
        "app",
        computerDocked ? "with-computer" : "",
        computerPopped ? "computer-popped" : "",
        sidebarCollapsed ? "sidebar-collapsed" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      style={{ "--rightpane": `${paneWidth}px` } as CSSProperties}
    >
      <Sidebar
        agents={agents}
        activeAgentId={speakingId}
        spriteState={sprite}
        runtimeStatus={runtimeStatus}
        busy={streaming}
        open={navOpen}
        collapsed={sidebarCollapsed}
        onToggleCollapsed={() => {
          setSidebarCollapsed((value) => !value);
          setNavOpen(false);
        }}
        onSelectAgent={selectAgent}
        onCreateAgent={createAgent}
        onOpenConnectors={() => openConnectors("list")}
        user={user}
      />
      <button
        type="button"
        className={navOpen ? "scrim on" : "scrim"}
        aria-label="Close sidebar"
        tabIndex={navOpen ? 0 : -1}
        onClick={() => setNavOpen(false)}
      />
      <main className={mobilePane === "chat" ? "main pane-chat" : "main pane-side"}>
        <header className="top">
          <button
            type="button"
            className="icon-btn"
            aria-label="Open sidebar"
            aria-expanded={navOpen}
            onClick={() => setNavOpen(true)}
          >
            <MenuIcon />
          </button>
          <h1>{speaking?.name ?? "Mockbot"}</h1>
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
          <h1>
            <BotSprite
              state={sprite}
              color={spriteColor}
              size={32}
              label={botSpriteLabel(spriteName, sprite)}
            />
            <span className="thread-title">{speaking?.name ?? "Mockbot"}</span>
          </h1>
          <ThreadActions
            replayHref={active && replayIds[active.id] ? `/runs/${replayIds[active.id]}` : null}
            computerOpen={computerOpen}
            onMemory={showMemory}
            onShowComputer={() => setComputerOpen(true)}
          />
        </header>
        <div className="chat-body">
          <Transcript
            messages={messages}
            streaming={streaming}
            livePhase={livePhase}
            spriteState={sprite}
            spriteColor={spriteColor}
            activities={activities}
            decidingId={decidingId}
            onDecide={(id, decision) => void decide(id, decision)}
            onAnswer={(id, text) => void answer(id, text)}
            onPlan={(id, action) => void decidePlan(id, action)}
            onOpenTrace={showTrace}
            agentName={speaking?.name ?? "Mockbot"}
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
            awaitingApproval={awaitingApproval || awaitingAsk || awaitingPlan || resuming}
            busyHint={
              awaitingPlan
                ? "Review the plan"
                : awaitingAsk
                  ? "Waiting for an answer"
                  : resuming
                    ? "Finishing the reply"
                    : undefined
            }
            placeholder={speaking ? `Message ${speaking.name}` : "Message Mockbot"}
            value={composerDraft}
            onValueChange={setComposerDraft}
            onAddConnector={() => openConnectors("add")}
            onSend={(text, options) => void send(text, options)}
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
            agentName={spriteName}
            spriteColor={spriteColor}
            onMemoriesChanged={refreshMemories}
            activities={activities}
            snapshot={computer}
            status={computerStatus}
            unavailableReason={computerError}
            messages={messages}
            onPop={() => setComputerPopped(true)}
            onComputerTab={chooseComputerTab}
          />
        </div>
      </main>
      {computerOpen ? (
        <SidePane
          tab={sideTab}
          onTab={setSideTab}
          onHide={hideComputer}
          memories={memories}
          memoryError={memoryError}
          agentId={speakingId}
          agentName={spriteName}
          spriteColor={spriteColor}
          onMemoriesChanged={refreshMemories}
          activities={activities}
          snapshot={computer}
          status={computerStatus}
          unavailableReason={computerError}
          messages={messages}
          popped={computerPopped}
          onPop={() => setComputerPopped((open) => !open)}
          paneWidth={paneWidth}
          onPaneWidth={setPaneWidth}
          onComputerTab={chooseComputerTab}
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
