"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Composer } from "./composer";
import { ComputerPane } from "./computer-pane";
import { ConversationList } from "./conversation-list";
import { Transcript } from "./transcript";
import { releaseDecision, settleDecision, stopDecision } from "../src/decision-lock";
import { SseParser } from "../src/sse";
import { applyClientEvent, emptyTrace, phaseFromEvent, streamedWeight } from "../src/trace";
import {
  activitiesAfterReconnect,
  activitiesAfterStop,
  activitiesFromMessages,
  describeTool,
  previewText,
  type ToolActivity,
} from "../src/tools/display";
import type { Conversation, LivePhase, Message, ToolCallStatus } from "../src/types";

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

export function Workspace() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [livePhase, setLivePhase] = useState<LivePhase | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [providerLabel, setProviderLabel] = useState("Mock provider");
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");
  const [computerOpen, setComputerOpen] = useState(true);
  const [navOpen, setNavOpen] = useState(false);
  const [mobilePane, setMobilePane] = useState<"chat" | "computer">("chat");
  const [activities, setActivities] = useState<ToolActivity[]>([]);
  const [selectedToolId, setSelectedToolId] = useState<string | null>(null);
  const [decidingId, setDecidingId] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const activeIdRef = useRef<string | null>(null);
  const activitiesRef = useRef(activities);
  const decidingRef = useRef<string | null>(null);
  activitiesRef.current = activities;

  const releaseApprovalLock = useCallback(() => {
    stopDecision(decidingRef);
    setDecidingId(null);
  }, []);

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
      setActiveId(data.conversation.id);
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
    [releaseApprovalLock],
  );

  const refreshList = useCallback(async () => {
    const response = await fetch("/api/conversations");
    if (!response.ok) return;
    const data = (await response.json()) as { conversations: Conversation[] };
    setConversations(data.conversations);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [listResponse, statusResponse] = await Promise.all([
        fetch("/api/conversations"),
        fetch("/api/status"),
      ]);
      if (cancelled) return;
      if (statusResponse.ok) {
        const status = (await statusResponse.json()) as { provider: string; model: string | null };
        setProviderLabel(
          status.provider === "openai"
            ? `OpenAI-compatible${status.model ? ` · ${status.model}` : ""}`
            : "Mock provider",
        );
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
  }, [selectConversation]);

  function newChat() {
    if (streaming) return;
    setNavOpen(false);
    setMobilePane("chat");
    setActiveId(null);
    setMessages([]);
    setActivities([]);
    setSelectedToolId(null);
    setError(null);
    setEditing(false);
    const url = new URL(window.location.href);
    url.searchParams.delete("c");
    window.history.replaceState(null, "", url);
  }

  async function rename(id: string, title: string) {
    const response = await fetch(`/api/conversations/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      setError(body?.error ?? "Could not rename conversation");
      return;
    }
    const data = (await response.json()) as { conversation: Conversation };
    setConversations((prev) => prev.map((item) => (item.id === id ? data.conversation : item)));
    setEditing(false);
  }

  async function remove(id: string) {
    const response = await fetch(`/api/conversations/${id}`, { method: "DELETE" });
    if (!response.ok) {
      setError("Could not delete conversation");
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
    setError(null);
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
              return [{ id, title, createdAt: now, updatedAt: now }, ...others];
            });
            setMessages((prev) =>
              prev.map((item) =>
                item.id === localUserId ? { ...item, conversationId: id } : item,
              ),
            );
          } else if (
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
            patchActivity(id, {
              state: status,
              output,
              preview: output ? previewText(output) : "",
            });
            releaseDecision(decidingRef, id);
            setDecidingId((current) => (current === id ? null : current));
          } else if (event.event === "error") {
            setError(String(payload.message ?? "The model request failed"));
          }
        }
      }

      if (conversationId) {
        await selectConversation(conversationId);
        await refreshList();
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
          setMessages((prev) => prev.filter((item) => item.id !== localUserId));
        }
        setError(sendError instanceof Error ? sendError.message : "Something went wrong");
      }
    } finally {
      setStreaming(false);
      setLivePhase(null);
      abortRef.current = null;
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
          setError(
            response.status === 404
              ? "That approval expired. Send the request again."
              : "Could not save the decision",
          );
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
  const awaitingApproval = activities.some((activity) => activity.state === "approval");

  return (
    <div className={computerOpen ? "app with-computer" : "app"}>
      <ConversationList
        conversations={conversations}
        activeId={activeId}
        providerLabel={providerLabel}
        busy={streaming}
        open={navOpen}
        onNew={newChat}
        onSelect={(id) => {
          setNavOpen(false);
          setMobilePane("chat");
          if (!streaming) void selectConversation(id);
        }}
      />
      <button
        type="button"
        className={navOpen ? "scrim on" : "scrim"}
        aria-label="Close conversations"
        tabIndex={navOpen ? 0 : -1}
        onClick={() => setNavOpen(false)}
      />
      <main className={mobilePane === "computer" ? "main pane-computer" : "main pane-chat"}>
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
            onClick={() => setMobilePane("computer")}
          >
            Computer
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
              <h1>{active?.title ?? "New chat"}</h1>
              <div className="header-actions">
                {active ? (
                  <>
                    <button
                      type="button"
                      className="ghost-text"
                      onClick={() => {
                        setDraftTitle(active.title);
                        setEditing(true);
                      }}
                      disabled={streaming}
                    >
                      Rename
                    </button>
                    <button
                      type="button"
                      className="ghost-text danger"
                      onClick={() => void remove(active.id)}
                      disabled={streaming}
                    >
                      Delete
                    </button>
                  </>
                ) : null}
                {computerOpen ? null : (
                  <button
                    type="button"
                    className="ghost-text desktop-only"
                    onClick={() => setComputerOpen(true)}
                  >
                    Show computer
                  </button>
                )}
              </div>
            </>
          )}
        </header>
        <div className="chat-body">
          <Transcript
            messages={messages}
            streaming={streaming}
            livePhase={livePhase}
            activities={activities}
            decidingId={decidingId}
            onDecide={(id, decision) => void decide(id, decision)}
            onSelectTool={setSelectedToolId}
          />
          {error ? (
            <p className="error" role="alert">
              {error}
            </p>
          ) : null}
          <Composer
            streaming={streaming}
            awaitingApproval={awaitingApproval}
            onSend={(text) => void send(text)}
            onStop={stopTurn}
          />
        </div>
        <div className="computer-sheet">
          <ComputerPane
            activities={activities}
            selectedId={selectedToolId}
            onSelect={setSelectedToolId}
          />
        </div>
      </main>
      {computerOpen ? (
        <ComputerPane
          activities={activities}
          selectedId={selectedToolId}
          onSelect={setSelectedToolId}
          onHide={() => setComputerOpen(false)}
        />
      ) : null}
    </div>
  );
}

function MenuIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      aria-hidden="true"
    >
      <path d="M4 7h16M4 12h16M4 17h10" strokeLinecap="round" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      aria-hidden="true"
    >
      <path d="M12 5v14M5 12h14" strokeLinecap="round" />
    </svg>
  );
}
