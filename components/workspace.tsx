"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Composer } from "./composer";
import { ConversationList } from "./conversation-list";
import { SidePane } from "./side-pane";
import { Transcript } from "./transcript";
import { SseParser } from "../src/sse";
import type { ToolActivity } from "./tool-activity";
import type { Conversation, Memory, Message } from "../src/types";

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readActivity(payload: Record<string, unknown>): ToolActivity | null {
  if (typeof payload.id !== "string" || typeof payload.title !== "string") return null;
  const state = payload.state === "running" ? "running" : "done";
  const kind =
    payload.kind === "search" || payload.kind === "read" || payload.kind === "draft"
      ? payload.kind
      : "generic";
  return {
    id: payload.id,
    title: payload.title,
    detail: typeof payload.detail === "string" ? payload.detail : undefined,
    state,
    kind,
  };
}

function preferLongerAssistant(local: Message[], remote: Message[]): Message[] {
  const localAssistant = [...local].reverse().find((message) => message.role === "assistant");
  const remoteAssistant = [...remote].reverse().find((message) => message.role === "assistant");
  if ((localAssistant?.content.length ?? 0) > (remoteAssistant?.content.length ?? 0)) return local;
  return remote;
}

export function Workspace() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [providerLabel, setProviderLabel] = useState("Mock provider");
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");
  const [computerOpen, setComputerOpen] = useState(true);
  const [sideTab, setSideTab] = useState<"computer" | "memory">("computer");
  const [memories, setMemories] = useState<Memory[] | null>(null);
  const [memoryError, setMemoryError] = useState<string | null>(null);
  const [activities, setActivities] = useState<ToolActivity[]>([]);
  const [navOpen, setNavOpen] = useState(false);
  const [mobilePane, setMobilePane] = useState<"chat" | "computer" | "memory">("chat");
  const abortRef = useRef<AbortController | null>(null);
  const activeIdRef = useRef<string | null>(null);

  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  const selectConversation = useCallback(async (id: string) => {
    const response = await fetch(`/api/conversations/${id}`);
    if (!response.ok) {
      setActiveId(null);
      setMessages([]);
      return;
    }
    const data = (await response.json()) as { conversation: Conversation; messages: Message[] };
    setActiveId(data.conversation.id);
    setMessages(data.messages);
    setEditing(false);
    setConversations((prev) =>
      prev.map((item) => (item.id === data.conversation.id ? data.conversation : item)),
    );
    const url = new URL(window.location.href);
    url.searchParams.set("c", data.conversation.id);
    window.history.replaceState(null, "", url);
  }, []);

  const refreshList = useCallback(async () => {
    const response = await fetch("/api/conversations");
    if (!response.ok) return;
    const data = (await response.json()) as { conversations: Conversation[] };
    setConversations(data.conversations);
  }, []);

  const refreshMemories = useCallback(async () => {
    const response = await fetch("/api/memories");
    if (!response.ok) {
      setMemoryError("Could not load memories");
      return;
    }
    const data = (await response.json()) as { memories: Memory[] };
    setMemories(data.memories);
    setMemoryError(null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [listResponse, statusResponse, memoryResponse] = await Promise.all([
        fetch("/api/conversations"),
        fetch("/api/status"),
        fetch("/api/memories"),
      ]);
      if (cancelled) return;
      if (statusResponse.ok) {
        const status = (await statusResponse.json()) as {
          provider: string;
          model: string | null;
          database?: string;
        };
        const providerName =
          status.provider === "openai"
            ? `OpenAI-compatible${status.model ? ` · ${status.model}` : ""}`
            : "Mock provider";
        const databaseName = status.database === "neon" ? "Neon" : "Local";
        setProviderLabel(`${providerName} · ${databaseName}`);
      }
      if (memoryResponse.ok) {
        const data = (await memoryResponse.json()) as { memories: Memory[] };
        setMemories(data.memories);
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

  function showMemory() {
    setComputerOpen(true);
    setSideTab("memory");
    setMobilePane("memory");
    setNavOpen(false);
    void refreshMemories();
  }

  function newChat() {
    if (streaming) return;
    setNavOpen(false);
    setMobilePane("chat");
    setActiveId(null);
    setMessages([]);
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
      setEditing(false);
      const url = new URL(window.location.href);
      url.searchParams.delete("c");
      window.history.replaceState(null, "", url);
    }
  }

  async function reloadKeepingLonger(id: string) {
    const response = await fetch(`/api/conversations/${id}`);
    if (!response.ok) return;
    const data = (await response.json()) as { conversation: Conversation; messages: Message[] };
    setActiveId(data.conversation.id);
    setMessages((local) => preferLongerAssistant(local, data.messages));
    setConversations((prev) =>
      prev.map((item) => (item.id === data.conversation.id ? data.conversation : item)),
    );
    const url = new URL(window.location.href);
    url.searchParams.set("c", data.conversation.id);
    window.history.replaceState(null, "", url);
  }

  async function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || streaming) return;
    setError(null);
    setEditing(false);
    const controller = new AbortController();
    abortRef.current = controller;
    setStreaming(true);
    setActivities([]);

    const localUserId = `local-${crypto.randomUUID()}`;
    setMessages((prev) => [
      ...prev,
      {
        id: localUserId,
        conversationId: activeIdRef.current ?? "",
        role: "user",
        content: trimmed,
        createdAt: new Date().toISOString(),
      },
    ]);

    let assistantLocalId: string | null = null;
    let conversationId = activeIdRef.current;
    let sawMeta = false;

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
          } else if (event.event === "tool") {
            const activity = readActivity(payload);
            if (!activity) continue;
            const id = conversationId ?? "";
            if (!assistantLocalId) {
              assistantLocalId = `local-${crypto.randomUUID()}`;
              const assistantId = assistantLocalId;
              setMessages((prev) => [
                ...prev,
                {
                  id: assistantId,
                  conversationId: id,
                  role: "assistant",
                  content: "",
                  createdAt: new Date().toISOString(),
                },
              ]);
            }
            setActivities((prev) => {
              const index = prev.findIndex((item) => item.id === activity.id);
              if (index === -1) return [...prev, activity];
              return prev.map((item) => (item.id === activity.id ? activity : item));
            });
          } else if (event.event === "delta") {
            const chunk = String(payload.text ?? "");
            const id = conversationId ?? "";
            if (!assistantLocalId) {
              assistantLocalId = `local-${crypto.randomUUID()}`;
              const assistantId = assistantLocalId;
              setMessages((prev) => [
                ...prev,
                {
                  id: assistantId,
                  conversationId: id,
                  role: "assistant",
                  content: chunk,
                  createdAt: new Date().toISOString(),
                },
              ]);
            } else {
              const assistantId = assistantLocalId;
              setMessages((prev) =>
                prev.map((item) =>
                  item.id === assistantId ? { ...item, content: item.content + chunk } : item,
                ),
              );
            }
          } else if (event.event === "error") {
            setError(String(payload.message ?? "The model request failed"));
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
          setMessages((prev) => prev.filter((item) => item.id !== localUserId));
        }
        setError(sendError instanceof Error ? sendError.message : "Something went wrong");
      }
    } finally {
      setStreaming(false);
      setActivities([]);
      abortRef.current = null;
    }
  }

  const active = conversations.find((item) => item.id === activeId) ?? null;

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
            onClick={() => setMobilePane("computer")}
          >
            Computer
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mobilePane === "memory"}
            className={mobilePane === "memory" ? "on" : undefined}
            onClick={() => {
              setMobilePane("memory");
              setSideTab("memory");
            }}
          >
            Memory
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
                <button type="button" className="ghost-text" onClick={showMemory}>
                  Memory
                </button>
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
          <Transcript messages={messages} streaming={streaming} activities={activities} />
          {error ? (
            <p className="error" role="alert">
              {error}
            </p>
          ) : null}
          <Composer
            streaming={streaming}
            onSend={(text) => void send(text)}
            onStop={() => abortRef.current?.abort()}
          />
        </div>
        <div className="computer-sheet">
          <SidePane
            tab={mobilePane === "memory" ? "memory" : "computer"}
            onTab={(tab) => setMobilePane(tab)}
            memories={memories}
            memoryError={memoryError}
            onMemoriesChanged={refreshMemories}
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
          onMemoriesChanged={refreshMemories}
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
