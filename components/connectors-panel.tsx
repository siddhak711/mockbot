"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import type { ConnectorRecord, ConnectorToolSetting } from "../src/connectors";
import { connectorSlug } from "../src/connectors";
import {
  CATALOG,
  CATALOG_CATEGORIES,
  catalogById,
  catalogInCategory,
  catalogIsWired,
  catalogTarget,
  searchCatalog,
  type CatalogCategory,
  type CatalogEntry,
} from "../src/connectors/catalog";
import { ReconnectAttempt } from "../src/connectors/reconnect";
import {
  applyBulk,
  detectInput,
  INVALID_TARGET_MESSAGE,
  type ListedTool,
  type ToolRisk,
} from "../src/connectors/policy";
import { ArrowLeftIcon, CloseIcon, PlugIcon, SearchIcon, SparkleIcon } from "./icons";
import { BotSprite } from "./bot-sprite";
import {
  Monogram,
  Notice,
  RiskPill,
  SearchField,
  Spinner,
  StepIcon,
  SwitchControl,
} from "./connector-bits";

type UiTool = ListedTool & { isNew?: boolean };

type Step = { id: string; label: string; state: "done" | "active" | "pending" };

type Draft = {
  name: string;
  transport: "http" | "stdio";
  target: string;
  auth: "oauth" | "apikey" | "none";
  apiKey: string;
  tools: UiTool[];
  catalogId?: string;
};

const DETECTING_STEPS: Step[] = [
  { id: "reach", label: "Reaching server…", state: "active" },
  { id: "transport", label: "Transport", state: "pending" },
  { id: "auth", label: "Checking sign-in…", state: "pending" },
  { id: "tools", label: "Listing tools", state: "pending" },
];
const PREVIEW_STEPS: Step[] = [
  { id: "reach", label: "Reached server (212 ms)", state: "done" },
  { id: "transport", label: "Transport: Streamable HTTP", state: "done" },
  { id: "auth", label: "Checking sign-in…", state: "active" },
  { id: "tools", label: "Listing tools", state: "pending" },
];
const PREVIEW_UNREACHABLE =
  "Couldn't reach mcp.acme.dev (timed out after 10 s). Check the URL, VPN, or that the server is running.";
const PREVIEW_AUTH_ERROR =
  'Notion returned "access_denied". You may have closed the window or declined access.';

export function ConnectorsPanel({
  open,
  intent,
  connectors,
  ready,
  initialQuery = "",
  preview,
  onClose,
  onChanged,
  onInsertPrompt,
  onStop,
  pendingReconnectId,
  onReconnectStarted,
}: {
  open: boolean;
  intent: "list" | "add";
  connectors: ConnectorRecord[];
  ready: boolean;
  initialQuery?: string;
  preview?: string;
  onClose: () => void;
  onChanged: () => Promise<void>;
  onInsertPrompt: (text: string) => void;
  onStop: () => void;
  pendingReconnectId?: string | null;
  onReconnectStarted?: () => void;
}) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const oauthExisting = useRef(new ReconnectAttempt());
  const popupWatch = useRef<ReturnType<typeof setInterval> | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const listReturn = useRef<"list" | "done" | null>(null);
  const onCloseRef = useRef(onClose);
  const caretPlacedOn = useRef<HTMLInputElement | null>(null);
  onCloseRef.current = onClose;
  const [search, setSearch] = useState(preview ? previewSearch(preview) : initialQuery);
  const [category, setCategory] = useState<CatalogCategory>("popular");
  const [hint, setHint] = useState("");
  const [mode, setMode] = useState(
    preview ? previewMode(preview) : intent === "add" ? "add" : "list",
  );
  const [steps, setSteps] = useState<Step[]>(preview ? PREVIEW_STEPS : DETECTING_STEPS);
  const [draft, setDraft] = useState<Draft | null>(preview ? previewDraft(preview) : null);
  const [manageId, setManageId] = useState<string | null>(
    preview === "manage" || preview === "disconnect"
      ? "preview-notion"
      : preview === "details"
        ? "preview-postgres"
        : null,
  );
  const [localTools, setLocalTools] = useState<UiTool[]>(preview ? previewTools(preview) : []);
  const [toolError, setToolError] = useState<string | null>(null);
  const [keyVisible, setKeyVisible] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [authError, setAuthError] = useState<string | null>(preview ? PREVIEW_AUTH_ERROR : null);
  const [toast, setToast] = useState<string | null>(null);
  const [noted, setNoted] = useState("");
  const [menu, setMenu] = useState<"bulk" | "tool" | null>(null);
  const [menuTool, setMenuTool] = useState<string | null>(null);
  const [tileIndex, setTileIndex] = useState(0);
  const [doneId, setDoneId] = useState<string | null>(null);
  const [unreachable, setUnreachable] = useState(preview ? PREVIEW_UNREACHABLE : "");

  const shownConnectors = preview ? previewConnectors(preview, connectors) : connectors;
  const active = shownConnectors.find((connector) => connector.id === manageId) ?? null;
  const [appliedPreview, setAppliedPreview] = useState<string | null>(preview ?? null);
  if (open && preview && appliedPreview !== preview) {
    setAppliedPreview(preview);
    applyPreviewState(preview, {
      setMode,
      setSearch,
      setUnreachable,
      setAuthError,
      setDraft,
      setLocalTools,
      setSteps,
      setManageId,
    });
  }

  useEffect(() => {
    if (!open || preview) return;
    setSearch(initialQuery);
    setCategory("popular");
    setHint("");
    setToolError(null);
    setNoted("");
    setWaiting(false);
    setMode(intent === "add" || initialQuery ? "add" : "list");
  }, [open, intent, initialQuery, preview]);

  useEffect(() => {
    if (!open) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement) returnFocus.current = active;
    return () => {
      const node = returnFocus.current;
      if (node && document.contains(node)) node.focus();
    };
  }, [open]);

  useEffect(() => {
    if (!open || preview || !pendingReconnectId) return;
    const connector = connectors.find((item) => item.id === pendingReconnectId);
    onReconnectStarted?.();
    if (connector) void reconnect(connector);
  }, [open, pendingReconnectId, preview]);

  useEffect(() => {
    return () => {
      if (popupWatch.current != null) clearInterval(popupWatch.current);
    };
  }, []);

  useEffect(() => {
    if (!open || preview || mode !== "add") return;
    const detected = detectInput(search);
    if (detected.kind === "search") return;
    if (!detected.valid) {
      setMode("invalid");
      return;
    }
    const timer = window.setTimeout(() => void probe(search), 150);
    return () => window.clearTimeout(timer);
  }, [search, mode, open, preview]);

  useEffect(() => {
    if (!open) {
      caretPlacedOn.current = null;
      return;
    }
    const node = dialogRef.current;
    if (!node) return;
    const focusable = () =>
      [
        ...node.querySelectorAll<HTMLElement>(
          "button:not(:disabled), input:not(:disabled), a[href], [tabindex]:not([tabindex='-1'])",
        ),
      ].filter((element) => !element.hasAttribute("disabled"));
    const timer = window.setTimeout(() => {
      if (mode === "add" || mode === "detecting" || mode === "invalid" || mode === "no-results") {
        const field = searchRef.current;
        if (!field) return;
        const remounted = caretPlacedOn.current !== field;
        if (document.activeElement !== field) field.focus();
        if (remounted) {
          field.setSelectionRange(field.value.length, field.value.length);
          caretPlacedOn.current = field;
        }
      } else {
        focusable()[0]?.focus();
      }
    }, 0);
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        if (mode === "disconnect") {
          setMode("manage");
          return;
        }
        if (mode === "oauth" || mode === "details") {
          if (mode === "oauth") abandonAdd();
          else setMode("list");
          return;
        }
        if (mode === "detecting") {
          abandonAdd();
          return;
        }
        onCloseRef.current();
        return;
      }
      if (event.key === "/" && document.activeElement?.tagName !== "INPUT") {
        event.preventDefault();
        searchRef.current?.focus();
      }
      if (event.key !== "Tab") return;
      const items = focusable();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }
    node.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(timer);
      node.removeEventListener("keydown", onKey);
    };
  }, [open, mode]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 3000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const title =
    mode === "list" ||
    mode === "done" ||
    mode === "manage" ||
    mode === "disconnect" ||
    mode === "details"
      ? mode === "manage" || mode === "disconnect"
        ? (active?.name ?? "Connector")
        : "Connectors"
      : "Add a connector";

  const entries = useMemo(() => {
    const base = catalogInCategory(category);
    return search.trim() ? searchCatalog(search, base) : base;
  }, [category, search]);
  async function probe(value: string, apiKey = "") {
    const detected = detectInput(value);
    if (
      detected.kind === "search" ||
      !detected.valid ||
      !("target" in detected) ||
      !detected.target
    ) {
      setMode(detected.kind === "search" ? "add" : "invalid");
      return;
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setMode("detecting");
    setSteps(DETECTING_STEPS);
    try {
      const response = await fetch("/api/connectors/detect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: value, ...(apiKey ? { apiKey } : {}) }),
        signal: controller.signal,
      });
      const body = (await response.json()) as {
        auth?: Draft["auth"];
        transport?: "http" | "stdio";
        transportLabel?: string;
        target?: string;
        name?: string;
        tools?: UiTool[];
        elapsedMs?: number;
        error?: string;
        code?: string;
      };
      if (controller.signal.aborted) return;
      if (!response.ok && body.code === "auth") {
        setKeyError(body.error ?? "That key was rejected.");
        setMode("apikey");
        return;
      }
      if (!response.ok) {
        setUnreachable(body.error ?? "Could not reach the server.");
        setMode("unreachable");
        return;
      }
      const transport = body.transport ?? (detected.kind === "command" ? "stdio" : "http");
      const next: Draft = {
        name: body.name || nameFromTarget(body.target || detected.target),
        transport,
        target: body.target || detected.target,
        auth: body.auth ?? "none",
        apiKey,
        tools: (body.tools ?? []).map((tool) => ({
          ...tool,
          enabled: tool.skipped ? false : tool.risk === "read",
          approval: tool.risk === "read" ? "auto" : "ask",
        })),
      };
      setDraft(next);
      setSteps(
        doneSteps(
          body.transportLabel || "Streamable HTTP",
          body.auth ?? "none",
          body.elapsedMs ?? 0,
        ),
      );
      const existingId = oauthExisting.current.take();
      if (existingId) {
        const id = existingId;
        const saved = await fetch(`/api/connectors/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reconnected: true, ...(apiKey ? { apiKey } : {}) }),
        });
        if (!saved.ok) {
          oauthExisting.current.start(id);
          const failed = (await saved.json().catch(() => null)) as { error?: string } | null;
          setAuthError(failed?.error ?? "Could not reconnect.");
          setMode("auth-failed");
          return;
        }
        await onChanged();
        setToast(`${next.name} reconnected`);
        setMode("list");
        return;
      }
      if (body.auth === "oauth") setMode("oauth");
      else if (body.auth === "apikey" && !apiKey) setMode("apikey");
      else if (transport === "stdio" && body.auth === "none") setMode("none");
      else setMode("review");
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") return;
      setUnreachable("Could not reach the server.");
      setMode("unreachable");
    }
  }

  function toolsFrom(connector: ConnectorRecord): UiTool[] {
    const seen = new Set(connector.seenTools ?? []);
    return Object.entries(connector.tools ?? {}).map(([name, setting]) => ({
      name,
      description: setting.description ?? "",
      risk: setting.risk ?? "write",
      enabled: setting.enabled,
      approval: setting.approval,
      skipped: Boolean(setting.skipped),
      isNew: !seen.has(name),
    }));
  }

  function openManage(connector: ConnectorRecord) {
    setManageId(connector.id);
    setLocalTools(toolsFrom(connector));
    setToolError(null);
    setMode("manage");
    void fetch(`/api/connectors/${connector.id}/tools`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ markSeen: true }),
    }).then(() => onChanged());
  }

  async function saveTools(connectorId: string, tools: UiTool[]) {
    const previous = localTools;
    setLocalTools(tools);
    setToolError(null);
    const payload: Record<string, { enabled: boolean; approval: "ask" | "auto" }> = {};
    for (const tool of tools) {
      if (tool.skipped) continue;
      payload[tool.name] = { enabled: tool.enabled, approval: tool.approval };
    }
    const response = await fetch(`/api/connectors/${connectorId}/tools`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tools: payload }),
    });
    if (!response.ok) {
      setLocalTools(previous);
      setToolError("Couldn't save those tool settings. Try again.");
      return;
    }
    await onChanged();
  }

  function updateDraftTools(tools: UiTool[]) {
    setDraft((current) => (current ? { ...current, tools } : current));
  }

  async function connectDraft() {
    if (!draft) return;
    const enabled = draft.tools.some((tool) => tool.enabled && !tool.skipped);
    if (!enabled) return;
    const tools: Record<string, { enabled: boolean; approval: "ask" | "auto" }> = {};
    for (const tool of draft.tools) {
      tools[tool.name] = { enabled: tool.enabled, approval: tool.approval };
    }
    const response = await fetch("/api/connectors", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: draft.name,
        transport: draft.transport,
        target: draft.target,
        ...(draft.apiKey ? { apiKey: draft.apiKey } : {}),
        tools,
      }),
    });
    const body = (await response.json().catch(() => null)) as {
      error?: unknown;
      message?: unknown;
      connector?: ConnectorRecord;
    } | null;
    if (!response.ok || !body?.connector) {
      setUnreachable(serverProvidedError(body) ?? "Could not add the connector.");
      setMode("unreachable");
      return;
    }
    oauthExisting.current.clear();
    await onChanged();
    showDone(body.connector.id, body.connector.name);
  }

  function showDone(id: string, name: string) {
    listReturn.current = null;
    setSearch("");
    setHint("");
    setDoneId(id);
    setToast(`${name} connected`);
    setMode("done");
  }

  function abandonAdd() {
    const back = listReturn.current;
    listReturn.current = null;
    oauthExisting.current.clear();
    abortRef.current?.abort();
    setWaiting(false);
    setMode(back ?? "add");
  }

  function showOauth(entry: CatalogEntry | null, name: string, existingId?: string) {
    if (mode === "list" || mode === "done") listReturn.current = mode;
    else if (mode !== "oauth" && mode !== "auth-failed") listReturn.current = null;
    if (existingId) oauthExisting.current.start(existingId);
    else oauthExisting.current.clear();
    setDraft((current) => {
      if (entry) {
        return {
          name: entry.name,
          transport: "http",
          target: catalogTarget(entry) ?? "",
          auth: "oauth",
          apiKey: "",
          tools: entry.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            risk: tool.risk,
            enabled: tool.risk === "read",
            approval: tool.risk === "read" ? "auto" : "ask",
            skipped: false,
          })),
          catalogId: entry.id,
        };
      }
      if (current) return { ...current, name, auth: "oauth" };
      return { name, transport: "http", target: "", auth: "oauth", apiKey: "", tools: [] };
    });
    setAuthError(null);
    setWaiting(false);
    setMode("oauth");
  }

  async function continueOauth() {
    if (preview) return;
    const name = draft?.name ?? "Connector";
    const entry = draft?.catalogId ? (catalogById(draft.catalogId) ?? null) : null;
    const existingId = oauthExisting.current.id;
    if (entry && !catalogIsWired(entry)) {
      setAuthError(`${entry.name} is not available yet.`);
      setMode("auth-failed");
      return;
    }
    if (entry?.composio?.enabled || entry?.oauth) {
      // Open during the click. A popup opened after the start request is blocked.
      const popup = window.open("about:blank", "mockbot-oauth", "popup,width=520,height=720");
      if (!popup) {
        setWaiting(false);
        setAuthError(`Allow the ${name} sign-in window, then try again.`);
        setMode("auth-failed");
        return;
      }
      try {
        popup.document.title = "Connecting";
        popup.document.body.textContent = `Connecting to ${name}…`;
      } catch {
        // Navigation below still uses this window when the placeholder cannot be written.
      }
      setWaiting(true);
      setAuthError(null);
      try {
        const response = await fetch("/api/connectors/oauth/start", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            catalogId: entry.id,
            ...(existingId ? { connectorId: existingId } : {}),
          }),
        });
        const body = (await response.json().catch(() => null)) as {
          authorizeUrl?: string;
          error?: string;
        } | null;
        if (popup.closed) {
          setWaiting(false);
          setAuthError(`Allow the ${name} sign-in window, then try again.`);
          setMode("auth-failed");
          return;
        }
        if (!response.ok || !body?.authorizeUrl) {
          popup.close();
          setWaiting(false);
          setAuthError(body?.error ?? `Could not start ${name} sign-in.`);
          setMode("auth-failed");
          return;
        }
        openOauthPopup(body.authorizeUrl, name, true, existingId, popup);
      } catch {
        if (!popup.closed) popup.close();
        setWaiting(false);
        setAuthError(`Could not start ${name} sign-in.`);
        setMode("auth-failed");
      }
      return;
    }
    openOauthPopup(`/connectors/oauth?name=${encodeURIComponent(name)}`, name, false, existingId);
  }

  function openOauthPopup(
    url: string,
    name: string,
    catalog: boolean,
    existingId: string | null,
    existing?: Window,
  ) {
    const popup = existing ?? window.open(url, "mockbot-oauth", "popup,width=520,height=720");
    if (!popup || popup.closed) {
      setWaiting(false);
      setAuthError(`Allow the ${name} sign-in window, then try again.`);
      setMode("auth-failed");
      return;
    }
    if (existing) {
      try {
        existing.location.href = url;
      } catch {
        if (!existing.closed) existing.close();
        setWaiting(false);
        setAuthError(`Could not start ${name} sign-in.`);
        setMode("auth-failed");
        return;
      }
    }
    setWaiting(true);
    let settled = false;
    const finish = (ok: boolean, account?: string, connectorId?: string, message?: string) => {
      if (settled) return;
      settled = true;
      window.removeEventListener("message", onMessage);
      if (popupWatch.current != null) clearInterval(popupWatch.current);
      popupWatch.current = null;
      setWaiting(false);
      if (!ok) {
        setAuthError(
          message ||
            `${name} returned "access_denied". You may have closed the window or declined access.`,
        );
        setMode("auth-failed");
        return;
      }
      if (catalog) {
        oauthExisting.current.clear();
        void onChanged().then(() => {
          if (existingId) {
            setToast(`${name} reconnected`);
            setMode("list");
            return;
          }
          showDone(connectorId || "", name);
        });
        return;
      }
      if (existingId) {
        void markReconnected(existingId, name);
        return;
      }
      void connectPastedOauth();
    };
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const data = event.data as {
        type?: string;
        ok?: boolean;
        account?: string;
        connectorId?: string;
        message?: string;
      };
      if (!data || data.type !== "mockbot-oauth") return;
      finish(Boolean(data.ok), data.account, data.connectorId, data.message);
    };
    window.addEventListener("message", onMessage);
    if (popupWatch.current != null) clearInterval(popupWatch.current);
    popupWatch.current = setInterval(() => {
      if (!popup.closed) return;
      window.setTimeout(() => finish(false), 300);
    }, 400);
  }

  async function markReconnected(id: string, name: string) {
    const response = await fetch(`/api/connectors/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reconnected: true }),
    });
    const failed = (await response.json().catch(() => null)) as {
      error?: unknown;
      message?: unknown;
    } | null;
    if (!response.ok) {
      setAuthError(serverProvidedError(failed) ?? "Could not reconnect.");
      setMode("auth-failed");
      return;
    }
    oauthExisting.current.clear();
    await onChanged();
    setToast(`${name} reconnected`);
    setMode("list");
  }

  async function connectPastedOauth() {
    if (!draft) return;
    oauthExisting.current.clear();
    const response = await fetch("/api/connectors", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: draft.name,
        transport: draft.transport,
        target: draft.target,
        oauth: true,
      }),
    });
    const body = (await response.json().catch(() => null)) as {
      error?: unknown;
      message?: unknown;
      connector?: ConnectorRecord;
    } | null;
    if (!response.ok || !body?.connector) {
      setAuthError(serverProvidedError(body) ?? `Could not connect ${draft.name}.`);
      setMode("auth-failed");
      return;
    }
    await onChanged();
    showDone(body.connector.id, body.connector.name);
  }

  async function disconnect(connector: ConnectorRecord) {
    onStop();
    const response = await fetch(`/api/connectors/${connector.id}`, { method: "DELETE" });
    if (!response.ok && response.status !== 204) {
      setToolError("Could not disconnect.");
      setMode("manage");
      return;
    }
    await onChanged();
    setMode("list");
    setManageId(null);
  }

  async function reconnect(connector: ConnectorRecord) {
    setManageId(connector.id);
    if (connector.catalogId || connector.authType === "oauth") {
      const entry = connector.catalogId ? (catalogById(connector.catalogId) ?? null) : null;
      showOauth(entry, connector.name, connector.id);
      return;
    }
    if (connector.authType === "apikey") {
      oauthExisting.current.start(connector.id);
      setDraft({
        name: connector.name,
        transport: connector.transport,
        target: connector.target,
        auth: "apikey",
        apiKey: "",
        tools: [],
      });
      setKeyError(null);
      setMode("apikey");
      return;
    }
    const response = await fetch(`/api/connectors/${connector.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reconnected: true }),
    });
    if (response.ok) {
      await onChanged();
      setToast(`${connector.name} reconnected`);
      setMode("list");
    }
  }

  function onGridKey(event: ReactKeyboardEvent, count: number) {
    const columns = window.innerWidth <= 760 ? 1 : 3;
    if (event.key === "ArrowRight") setTileIndex((index) => Math.min(count - 1, index + 1));
    else if (event.key === "ArrowLeft") setTileIndex((index) => Math.max(0, index - 1));
    else if (event.key === "ArrowDown")
      setTileIndex((index) => Math.min(count - 1, index + columns));
    else if (event.key === "ArrowUp") setTileIndex((index) => Math.max(0, index - columns));
    else return;
    event.preventDefault();
  }

  const searchShown =
    mode === "add" ||
    mode === "detecting" ||
    mode === "invalid" ||
    mode === "no-results" ||
    mode === "oauth";
  const noResults =
    mode === "add" &&
    search.trim() &&
    detectInput(search).kind === "search" &&
    entries.length === 0;
  const visibleMode = noResults ? "no-results" : mode;
  const done = shownConnectors.find((connector) => connector.id === doneId) ?? shownConnectors[0];
  const catalogSearching = Boolean(search.trim()) && detectInput(search).kind === "search";
  const availableCatalog =
    preview === "loading" || (!ready && !preview) ? (
      <SkeletonGrid />
    ) : (
      <section className="connector-catalog" aria-label="Add a connector">
        <h3 className="connector-section">Add a connector</h3>
        <SearchField
          value={search}
          placeholder="Search connectors, or paste a URL / command"
          inputRef={searchRef}
          onChange={(value) => {
            setSearch(value);
            setHint("");
          }}
          onPaste={(value) => {
            if (detectInput(value).kind !== "search") setMode("add");
          }}
          onSubmit={() => {
            const detected = detectInput(search);
            if (detected.kind !== "search" && !detected.valid) setMode("invalid");
            else if (detected.kind !== "search") {
              setMode("add");
              void probe(search);
            }
          }}
          onCancel={() => {
            setSearch("");
            setHint("");
          }}
        />
        {hint ? <p className="connector-help">{hint}</p> : null}
        {catalogSearching && entries.length === 0 ? (
          <div className="connector-empty inline">
            <h3>No connectors match “{search.trim()}”</h3>
            <p className="t2">Have a server URL or command? Paste it above.</p>
            <div className="pair">
              <button
                type="button"
                className="btn secondary"
                onClick={() => searchRef.current?.focus()}
              >
                Add by URL
              </button>
              <button
                type="button"
                className="btn ghost"
                onClick={() => setNoted(`Noted “${search.trim()}”.`)}
              >
                Request a connector
              </button>
            </div>
            {noted ? <p role="status">{noted}</p> : null}
          </div>
        ) : null}
        <CatalogBrowser
          entries={entries}
          connectors={shownConnectors}
          category={category}
          tileIndex={tileIndex}
          onCategory={setCategory}
          onGridKey={onGridKey}
          onConnect={(entry) => showOauth(entry, entry.name)}
          onManage={openManage}
          onPaste={() => {
            setHint("Paste https://…, npx …, uvx …, or JSON config");
            searchRef.current?.focus();
          }}
        />
      </section>
    );

  if (!open) return null;

  return (
    <div className="connector-modal">
      <div
        ref={dialogRef}
        className="connector-window"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <header className="connector-head">
          {mode === "manage" || mode === "disconnect" ? (
            <button
              type="button"
              className="icon-btn back-btn"
              aria-label="Back"
              onClick={() => setMode("list")}
            >
              <ArrowLeftIcon />
            </button>
          ) : (
            <PlugIcon />
          )}
          <h2 id={titleId}>{title}</h2>
          <span className="grow" />
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            <CloseIcon />
          </button>
        </header>
        <div className="connector-body">
          {searchShown ? (
            <>
              <SearchField
                value={search}
                placeholder="Search connectors, or paste a URL / command"
                invalid={visibleMode === "invalid"}
                describedBy={visibleMode === "invalid" ? "connector-search-error" : undefined}
                busy={visibleMode === "detecting"}
                inputRef={searchRef}
                onChange={(value) => {
                  setSearch(value);
                  setHint("");
                  if (mode !== "add") {
                    abandonAdd();
                  }
                }}
                onSubmit={() => {
                  const detected = detectInput(search);
                  if (detected.kind !== "search" && !detected.valid) setMode("invalid");
                  else if (detected.kind !== "search") void probe(search);
                }}
                onCancel={() => abandonAdd()}
              />
              {hint ? <p className="connector-help">{hint}</p> : null}
              {visibleMode === "invalid" ? (
                <p id="connector-search-error" className="field-error" role="alert">
                  {INVALID_TARGET_MESSAGE}
                </p>
              ) : null}
            </>
          ) : null}

          {visibleMode === "list" && !ready && !preview && shownConnectors.length === 0 ? (
            <SkeletonGrid />
          ) : null}
          {visibleMode === "list" && (ready || preview) && shownConnectors.length === 0 ? (
            <div className="connector-empty">
              <BotSprite state="idle" size={64} label="Mockbot, ready" />
              <h3>No connectors yet</h3>
              <p>Connect an app so mockbot can search, read, and act for you.</p>
              <button type="button" className="btn primary" onClick={() => setMode("add")}>
                Browse connectors
              </button>
              <button type="button" className="t2" onClick={() => setMode("add")}>
                or paste a server URL
              </button>
            </div>
          ) : null}
          {visibleMode === "list" && shownConnectors.length > 0 ? (
            <>
              <section aria-label="Connected">
                <h3 className="connector-section">Connected</h3>
                <div className="connected-connectors">
                  {shownConnectors.map((connector) => (
                    <ConnectorCard
                      key={connector.id}
                      connector={connector}
                      onManage={() => openManage(connector)}
                      onReconnect={() => void reconnect(connector)}
                      onDetails={() => {
                        setManageId(connector.id);
                        setMode("details");
                      }}
                    />
                  ))}
                </div>
              </section>
              {availableCatalog}
            </>
          ) : null}

          {(visibleMode === "add" || visibleMode === "oauth") &&
          (preview === "loading" || (!ready && !preview)) ? (
            <SkeletonGrid />
          ) : null}
          {(visibleMode === "add" || visibleMode === "oauth") &&
          preview !== "loading" &&
          (ready || preview === "catalog" || preview === "oauth") ? (
            <CatalogBrowser
              entries={entries}
              connectors={shownConnectors}
              category={category}
              tileIndex={tileIndex}
              onCategory={setCategory}
              onGridKey={onGridKey}
              onConnect={(entry) => showOauth(entry, entry.name)}
              onManage={openManage}
              onPaste={() => {
                setHint("Paste https://…, npx …, uvx …, or JSON config");
                searchRef.current?.focus();
              }}
            />
          ) : null}

          {visibleMode === "no-results" ? (
            <div className="connector-empty">
              <h3>No connectors match “{search.trim()}”</h3>
              <p className="t2">Have a server URL or command? Paste it above.</p>
              <div className="pair">
                <button
                  type="button"
                  className="btn secondary"
                  onClick={() => searchRef.current?.focus()}
                >
                  Add by URL
                </button>
                <button
                  type="button"
                  className="btn ghost"
                  onClick={() => setNoted(`Noted “${search.trim()}”.`)}
                >
                  Request a connector
                </button>
              </div>
              {noted ? <p role="status">{noted}</p> : null}
            </div>
          ) : null}

          {visibleMode === "detecting" ? (
            <div className="check-list" aria-live="polite">
              {steps.map((step) => (
                <div
                  key={step.id}
                  className={step.state === "pending" ? "check-row pending" : "check-row"}
                >
                  <StepIcon state={step.state} />
                  <span>{step.label}</span>
                </div>
              ))}
            </div>
          ) : null}

          {visibleMode === "unreachable" ? (
            <>
              <Notice tone="danger">{unreachable}</Notice>
              <div className="pair">
                <button
                  type="button"
                  className="btn secondary"
                  onClick={() => void probe(search, draft?.apiKey ?? "")}
                >
                  Retry
                </button>
                <button type="button" className="btn ghost" onClick={() => abandonAdd()}>
                  Edit URL
                </button>
              </div>
            </>
          ) : null}

          {visibleMode === "apikey" && draft ? (
            <AuthBlock
              title={draft.name}
              detail="API key"
              error={keyError}
              extra={
                <>
                  <label className="key-field">
                    <span className="sr-only">API key</span>
                    <input
                      type={keyVisible ? "text" : "password"}
                      value={draft.apiKey}
                      autoComplete="off"
                      aria-invalid={Boolean(keyError)}
                      aria-describedby="api-key-help"
                      onChange={(event) => {
                        setKeyError(null);
                        setDraft({ ...draft, apiKey: event.target.value });
                      }}
                    />
                    <button
                      type="button"
                      className="icon-btn"
                      aria-label={keyVisible ? "Hide API key" : "Show API key"}
                      onClick={() => setKeyVisible((value) => !value)}
                    >
                      <SearchIcon />
                    </button>
                  </label>
                  <p id="api-key-help" className="t2">
                    Stored encrypted on the server, never sent to the model.{" "}
                    <a className="text-link" href="#api-key-help">
                      Where do I find this?
                    </a>
                  </p>
                </>
              }
              primary="Verify & continue"
              onPrimary={() => void probe(draft.target, draft.apiKey)}
              onBack={() => abandonAdd()}
            />
          ) : null}

          {visibleMode === "none" && draft ? (
            <>
              <Identity name={draft.name} detail="Local server" />
              <Notice tone="warn">Runs on this machine with your user's file access.</Notice>
              <div className="pair">
                <button type="button" className="btn ghost" onClick={() => abandonAdd()}>
                  Back
                </button>
                <button type="button" className="btn primary" onClick={() => setMode("review")}>
                  Review tools
                </button>
              </div>
            </>
          ) : null}

          {visibleMode === "auth-failed" ? (
            <>
              <Identity name={draft?.name ?? "Notion"} />
              <Notice tone="danger">{authError}</Notice>
              <div className="pair">
                <button type="button" className="btn ghost" onClick={() => abandonAdd()}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn primary"
                  onClick={() => {
                    const entry = draft?.catalogId ? (catalogById(draft.catalogId) ?? null) : null;
                    showOauth(
                      entry,
                      draft?.name ?? "Connector",
                      oauthExisting.current.id ?? undefined,
                    );
                  }}
                >
                  Try again
                </button>
              </div>
            </>
          ) : null}

          {visibleMode === "review" && draft ? (
            <ToolEditor
              tools={draft.tools}
              error={null}
              connectLabel="Connect"
              help={draft.auth === "oauth" ? "Sign-in opens after Connect" : ""}
              onChange={updateDraftTools}
              onConnect={() => void connectDraft()}
              onCancel={() => abandonAdd()}
              menu={menu}
              menuTool={menuTool}
              setMenu={setMenu}
              setMenuTool={setMenuTool}
              allowAlways={false}
            />
          ) : null}

          {visibleMode === "done" && done ? (
            <>
              <ConnectorCard connector={done} onManage={() => openManage(done)} />
              <button
                type="button"
                className="try-chip"
                onClick={() => {
                  const entry = done.catalogId ? catalogById(done.catalogId) : undefined;
                  onInsertPrompt(entry?.samplePrompt ?? `Use ${done.name} to look something up`);
                  onClose();
                }}
              >
                <SparkleIcon />
                <span>
                  {done.catalogId
                    ? catalogById(done.catalogId)?.samplePrompt
                    : `Use ${done.name} to look something up`}
                </span>
              </button>
              {shownConnectors.filter((connector) => connector.id !== done.id).length > 0 ? (
                <div className="other-connectors">
                  <div className="t2">Other connectors</div>
                  {shownConnectors
                    .filter((connector) => connector.id !== done.id)
                    .map((connector) => (
                      <ConnectorCard
                        key={connector.id}
                        connector={connector}
                        onManage={() => openManage(connector)}
                        onReconnect={() => void reconnect(connector)}
                      />
                    ))}
                </div>
              ) : null}
              {availableCatalog}
            </>
          ) : null}

          {(visibleMode === "manage" || visibleMode === "disconnect") && active ? (
            <>
              <ConnectorCard connector={active} />
              <ToolEditor
                tools={localTools}
                error={toolError}
                connectLabel=""
                onChange={(tools) => void saveTools(active.id, tools)}
                onCancel={() => setMode("list")}
                menu={menu}
                menuTool={menuTool}
                setMenu={setMenu}
                setMenuTool={setMenuTool}
                allowAlways
              />
              <div className="pair">
                <button
                  type="button"
                  className="btn secondary"
                  onClick={() => void reconnect(active)}
                >
                  Re-authenticate
                </button>
                <button
                  type="button"
                  className="btn ghost"
                  style={{ color: "var(--danger)" }}
                  onClick={() => setMode("disconnect")}
                >
                  Disconnect
                </button>
              </div>
            </>
          ) : null}

          {visibleMode === "details" && active ? (
            <div className="sheet" role="dialog" aria-label="Error details">
              <h3>{active.name}</h3>
              <p className="t2">{active.statusDetail || "The connector reported an error."}</p>
              <div className="sheet-actions">
                <button type="button" className="btn ghost" onClick={() => setMode("list")}>
                  Close
                </button>
              </div>
            </div>
          ) : null}
        </div>
        {visibleMode === "review" ? null : null}
        {visibleMode === "oauth" ? (
          <div className="sheet-scrim">
            <OauthSheet
              name={draft?.name ?? "Connector"}
              entry={draft?.catalogId ? catalogById(draft.catalogId) : undefined}
              waiting={waiting || preview === "oauth-wait"}
              onCancel={() => abandonAdd()}
              onContinue={() => continueOauth()}
            />
          </div>
        ) : null}
        {visibleMode === "disconnect" && active ? (
          <div className="sheet-scrim">
            <div className="sheet" role="dialog" aria-labelledby="disconnect-title">
              <h3 id="disconnect-title">Disconnect {active.name}?</h3>
              <p className="t2">
                mockbot loses access to its {Object.keys(active.tools ?? {}).length} tools. Running
                tasks using them will stop. You can reconnect anytime.
              </p>
              <div className="sheet-actions">
                <button type="button" className="btn ghost" onClick={() => setMode("manage")}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn danger"
                  onClick={() => void disconnect(active)}
                >
                  Disconnect
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
      {toast ? (
        <div className="toast" role="status">
          {toast}
        </div>
      ) : null}
    </div>
  );
}

/** The caller's own link. A shared catalog row is "not connected" until this user links it. */
function callerLinked(connector: ConnectorRecord | undefined, catalogId: string): boolean {
  return connector?.catalogId === catalogId && connector.status === "connected";
}

function CatalogBrowser({
  entries,
  connectors,
  category,
  tileIndex,
  onCategory,
  onGridKey,
  onConnect,
  onManage,
  onPaste,
}: {
  entries: CatalogEntry[];
  connectors: ConnectorRecord[];
  category: CatalogCategory;
  tileIndex: number;
  onCategory: (category: CatalogCategory) => void;
  onGridKey: (event: ReactKeyboardEvent, count: number) => void;
  onConnect: (entry: CatalogEntry) => void;
  onManage: (connector: ConnectorRecord) => void;
  onPaste: () => void;
}) {
  return (
    <>
      <div className="connector-pills" role="tablist" aria-label="Categories">
        {CATALOG_CATEGORIES.map((item) => (
          <button
            key={item.id}
            type="button"
            className={item.id === category ? "pill on" : "pill"}
            aria-pressed={item.id === category}
            onClick={() => onCategory(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div
        className="connector-grid"
        role="list"
        aria-label="Available connectors"
        onKeyDown={(event) => onGridKey(event, entries.length + 1)}
      >
        {entries.map((entry, index) => {
          const link = connectors.find((connector) => connector.catalogId === entry.id);
          const connected = callerLinked(link, entry.id);
          return (
            <article
              key={entry.id}
              className="connector-tile"
              role="listitem"
              data-catalog-id={entry.id}
              tabIndex={index === tileIndex ? 0 : -1}
            >
              <div className="connector-tile-top">
                <Monogram label={entry.name} color={entry.color} ink={entry.inkMonogram} />
                <div>
                  <div className="t1">{entry.name}</div>
                  <div className="t2">{entry.description}</div>
                </div>
              </div>
              {connected && link ? (
                <button type="button" className="btn secondary" onClick={() => onManage(link)}>
                  Manage
                </button>
              ) : catalogIsWired(entry) ? (
                <button type="button" className="btn secondary" onClick={() => onConnect(entry)}>
                  Connect
                </button>
              ) : (
                <>
                  <button type="button" className="btn secondary" disabled>
                    Connect
                  </button>
                  <span className="pill">Not available yet</span>
                </>
              )}
              {connected ? (
                <span className="pill success">● Connected</span>
              ) : (
                <span className="pill">● Not connected</span>
              )}
            </article>
          );
        })}
        <article
          className="connector-tile"
          role="listitem"
          tabIndex={tileIndex === entries.length ? 0 : -1}
        >
          <div className="connector-tile-top">
            <Monogram label="+" muted />
            <div>
              <div className="t1">Custom URL</div>
              <div className="t2">Paste any MCP server</div>
            </div>
          </div>
          <button type="button" className="btn secondary" onClick={onPaste}>
            Paste URL
          </button>
        </article>
      </div>
    </>
  );
}

function SkeletonGrid() {
  return (
    <div className="connector-grid" aria-hidden="true">
      {Array.from({ length: 9 }, (_, index) => (
        <div key={index} className="skeleton-tile" />
      ))}
    </div>
  );
}

function Identity({ name, detail }: { name: string; detail?: string }) {
  const entry = CATALOG.find((item) => item.name === name);
  return (
    <div className="identity">
      <Monogram label={name} color={entry?.color} ink={entry?.inkMonogram ?? !entry} large />
      <div>
        <div className="t1">{name}</div>
        {detail ? <div className="t2">{detail}</div> : null}
      </div>
    </div>
  );
}

function ConnectorCard({
  connector,
  onManage,
  onReconnect,
  onDetails,
}: {
  connector: ConnectorRecord;
  onManage?: () => void;
  onReconnect?: () => void;
  onDetails?: () => void;
}) {
  const entry = connector.catalogId ? catalogById(connector.catalogId) : undefined;
  const status = connector.status ?? "connected";
  const count = Object.values(connector.tools ?? {}).filter(
    (tool) => tool.enabled && !tool.skipped,
  ).length;
  const account = connector.accountLabel || connector.name;
  const detail =
    status === "not connected"
      ? "Not connected"
      : status === "reconnect"
        ? connector.statusDetail || "Tools are paused."
        : status === "error"
          ? connector.statusDetail || "The last call failed."
          : `${account} · ${count} tools on · write tools ask first`;
  return (
    <article
      className={status === "reconnect" ? "connector-card warn" : "connector-card"}
      data-connector={connector.name}
    >
      <div className="connector-tile-top">
        <Monogram
          label={connector.name}
          color={entry?.color}
          ink={entry ? entry.inkMonogram : true}
          large
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="t1">{connector.name}</div>
          <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
            {status === "connected" ? <span className="pill success">● Connected</span> : null}
            {status === "not connected" ? <span className="pill">● Not connected</span> : null}
            {status === "error" ? <span className="pill danger">● Error</span> : null}
            {status === "reconnect" ? <span className="pill warn">● Reconnect needed</span> : null}
          </div>
          <p className="t2">{detail}</p>
        </div>
        {status === "connected" && onManage ? (
          <button type="button" className="btn secondary" onClick={onManage}>
            Manage
          </button>
        ) : null}
        {status === "not connected" && onReconnect ? (
          <button type="button" className="btn primary" onClick={onReconnect}>
            Connect
          </button>
        ) : null}
        {status === "reconnect" && onReconnect ? (
          <button type="button" className="btn primary" onClick={onReconnect}>
            Reconnect
          </button>
        ) : null}
        {status === "error" && onDetails ? (
          <button type="button" className="btn secondary" onClick={onDetails}>
            Details
          </button>
        ) : null}
      </div>
    </article>
  );
}

function ToolEditor({
  tools,
  error,
  connectLabel,
  help,
  onChange,
  onConnect,
  onCancel,
  menu,
  menuTool,
  setMenu,
  setMenuTool,
  allowAlways,
}: {
  tools: UiTool[];
  error: string | null;
  connectLabel: string;
  help?: string;
  onChange: (tools: UiTool[]) => void;
  onConnect?: () => void;
  onCancel: () => void;
  menu: "bulk" | "tool" | null;
  menuTool: string | null;
  setMenu: (menu: "bulk" | "tool" | null) => void;
  setMenuTool: (name: string | null) => void;
  allowAlways: boolean;
}) {
  const available = tools.filter((tool) => !tool.skipped).length;
  const enabled = tools.filter((tool) => tool.enabled && !tool.skipped).length;
  const skipped = tools.filter((tool) => tool.skipped);
  return (
    <div>
      <div className="connector-toolbar">
        <div className="t1">
          {skipped.length > 0
            ? `${available} of ${tools.length} tools available`
            : `${tools.length} tools found`}
        </div>
        <span className="grow" />
        <button
          type="button"
          className="btn ghost"
          onClick={() => onChange(applyBulk(tools, "read-on"))}
        >
          All read on
        </button>
        <button
          type="button"
          className="btn ghost"
          onClick={() => onChange(applyBulk(tools, "all-off"))}
        >
          All off
        </button>
        <button
          type="button"
          className="btn ghost"
          aria-label="More tool actions"
          onClick={() => setMenu(menu === "bulk" ? null : "bulk")}
        >
          …
        </button>
      </div>
      {menu === "bulk" ? (
        <div className="menu" role="menu">
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onChange(applyBulk(tools, "all-on"));
              setMenu(null);
            }}
          >
            Enable all (incl. write)
          </button>
        </div>
      ) : null}
      {skipped.length > 0 ? (
        <Notice tone="warn">
          {skipped.length} tool has an invalid schema and was skipped:{" "}
          {skipped.map((tool) => tool.name).join(", ")}
        </Notice>
      ) : null}
      <div className="tool-table">
        {tools.map((tool) => (
          <div key={tool.name} className={tool.skipped ? "tool-row skipped" : "tool-row"}>
            <span className="tool-name">{tool.name}</span>
            {tool.isNew ? <span className="pill">new</span> : null}
            <span className="t2">{tool.description}</span>
            {tool.skipped ? <span className="pill">skipped</span> : <RiskPill risk={tool.risk} />}
            {tool.skipped ? null : (
              <>
                {allowAlways && tool.risk === "write" ? (
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label={`${tool.name} settings`}
                    onClick={() => {
                      setMenuTool(tool.name);
                      setMenu(menuTool === tool.name ? null : "tool");
                    }}
                  >
                    …
                  </button>
                ) : null}
                <SwitchControl
                  checked={tool.enabled}
                  label={`${tool.name} — ${tool.risk}`}
                  onChange={(checked) =>
                    onChange(
                      tools.map((item) =>
                        item.name === tool.name ? { ...item, enabled: checked } : item,
                      ),
                    )
                  }
                />
              </>
            )}
            {menu === "tool" && menuTool === tool.name ? (
              <div className="menu" role="menu">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    onChange(
                      tools.map((item) =>
                        item.name === tool.name
                          ? { ...item, enabled: true, approval: "auto" }
                          : item,
                      ),
                    );
                    setMenu(null);
                  }}
                >
                  Always allow
                </button>
              </div>
            ) : null}
          </div>
        ))}
      </div>
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
      {connectLabel ? (
        <div
          className="connector-footer"
          style={{ margin: "12px -16px -16px", padding: "12px 0 0" }}
        >
          <span className="t2">{help}</span>
          <span className="grow" />
          <button type="button" className="btn ghost" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={enabled === 0}
            title={enabled === 0 ? "Turn on at least one tool" : undefined}
            onClick={onConnect}
          >
            {connectLabel}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function AuthBlock({
  title,
  detail,
  error,
  extra,
  primary,
  onPrimary,
  onBack,
}: {
  title: string;
  detail?: string;
  error: string | null;
  extra: ReactNode;
  primary: string;
  onPrimary: () => void;
  onBack: () => void;
}) {
  return (
    <div>
      <Identity name={title} detail={detail} />
      {extra}
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="pair">
        <button type="button" className="btn ghost" onClick={onBack}>
          Back
        </button>
        <button type="button" className="btn primary" onClick={onPrimary}>
          {primary}
        </button>
      </div>
    </div>
  );
}

function OauthSheet({
  name,
  entry,
  waiting,
  onCancel,
  onContinue,
}: {
  name: string;
  entry?: CatalogEntry;
  waiting: boolean;
  onCancel: () => void;
  onContinue: () => void;
}) {
  const permissions = entry?.permissions ?? [
    { allowed: true, text: "Search and read what you share" },
    { allowed: true, text: "Make changes (asks you first)" },
    { allowed: false, text: "Never sees your password" },
  ];
  return (
    <div className="sheet" role="dialog" aria-labelledby="oauth-title">
      <div className="identity">
        <BotSprite state={waiting ? "thinking" : "idle"} size={36} label="Mockbot" />
        <span aria-hidden="true">⇄</span>
        <Monogram label={name} color={entry?.color} ink={entry?.inkMonogram ?? true} large />
      </div>
      <h3 id="oauth-title">Connect {name}</h3>
      {waiting ? (
        <p className="t2">
          <Spinner /> Waiting for {name}…
        </p>
      ) : (
        <>
          <p className="t2">mockbot will be able to:</p>
          <ul>
            {permissions.map((item) => (
              <li key={item.text}>
                <span style={{ color: item.allowed ? "var(--success)" : "var(--muted)" }}>
                  {item.allowed ? "✓" : "✗"}
                </span>
                <span style={{ color: item.allowed ? "var(--ink)" : "var(--muted)" }}>
                  {item.text}
                </span>
              </li>
            ))}
          </ul>
          <p className="t2">
            {entry?.composio?.enabled
              ? `Opens ${name} sign-in through Composio`
              : `Opens ${name} sign-in in a window`}
          </p>
        </>
      )}
      <div className="sheet-actions">
        <button type="button" className="btn ghost" onClick={onCancel}>
          Cancel
        </button>
        {waiting ? null : (
          <button type="button" className="btn primary" onClick={onContinue}>
            Continue to {name} ↗
          </button>
        )}
      </div>
    </div>
  );
}

function doneSteps(transport: string, auth: string, elapsed: number): Step[] {
  const authLabel = auth === "oauth" ? "OAuth 2.1" : auth === "apikey" ? "API key" : "No sign-in";
  return [
    { id: "reach", label: `Reached server (${elapsed} ms)`, state: "done" },
    { id: "transport", label: `Transport: ${transport}`, state: "done" },
    { id: "auth", label: authLabel, state: "done" },
    { id: "tools", label: "Listing tools", state: "done" },
  ];
}

function nameFromTarget(target: string): string {
  try {
    return new URL(target).hostname.replace(/^www\./, "");
  } catch {
    return target.split(/\s+/)[0] || "Connector";
  }
}

function applyPreviewState(
  name: string,
  setters: {
    setMode: (mode: string) => void;
    setSearch: (search: string) => void;
    setUnreachable: (message: string) => void;
    setAuthError: (message: string) => void;
    setDraft: (draft: Draft | null) => void;
    setLocalTools: (tools: UiTool[]) => void;
    setSteps: (steps: Step[]) => void;
    setManageId: (id: string | null) => void;
  },
) {
  setters.setMode(previewMode(name));
  setters.setSearch(previewSearch(name));
  setters.setUnreachable(PREVIEW_UNREACHABLE);
  setters.setAuthError(PREVIEW_AUTH_ERROR);
  setters.setDraft(previewDraft(name));
  setters.setLocalTools(previewTools(name));
  setters.setSteps(PREVIEW_STEPS);
  if (name === "manage" || name === "disconnect") setters.setManageId("preview-notion");
  if (name === "details") setters.setManageId("preview-postgres");
}

function previewMode(preview: string): string {
  if (preview === "catalog" || preview === "loading") return "add";
  if (preview === "oauth" || preview === "oauth-wait") return "oauth";
  if (preview === "connected") return "done";
  if (preview === "empty" || preview === "error" || preview === "reconnect") return "list";
  if (preview === "partial") return "review";
  return preview;
}

function previewSearch(preview: string): string {
  if (preview === "detecting" || preview === "unreachable") return "https://mcp.acme.dev/mcp";
  if (preview === "invalid") return "https://";
  if (preview === "no-results") return "acme crm";
  return "";
}

function previewDraft(preview: string): Draft | null {
  if (preview === "apikey") {
    return {
      name: "Acme CRM",
      transport: "http",
      target: "https://mcp.acme.dev/mcp",
      auth: "apikey",
      apiKey: "",
      tools: [],
    };
  }
  if (preview === "none") {
    return {
      name: "Filesystem",
      transport: "stdio",
      target: "npx filesystem",
      auth: "none",
      apiKey: "",
      tools: [],
    };
  }
  if (preview === "oauth" || preview === "oauth-wait") {
    const entry = catalogById("notion");
    return entry
      ? {
          name: entry.name,
          transport: "http",
          target: catalogTarget(entry) ?? "",
          auth: "oauth",
          apiKey: "",
          tools: [],
          catalogId: "notion",
        }
      : null;
  }
  if (preview === "partial" || preview === "review")
    return {
      name: "Acme",
      transport: "http",
      target: "https://mcp.acme.dev/mcp",
      auth: "none",
      apiKey: "",
      tools: previewTools(preview),
    };
  return null;
}

function previewTools(preview: string): UiTool[] {
  if (preview === "partial") {
    return [
      tool("search", "Search records", "read", true),
      tool("get_record", "Read a record", "read", true),
      tool("list_records", "List records", "read", true),
      tool("create_record", "Create a record", "write", false),
      tool("delete_record", "Delete a record", "destructive", false),
      { ...tool("export_pdf", "Export a record", "write", false), skipped: true },
    ];
  }
  if (preview === "manage" || preview === "disconnect") {
    return (catalogById("notion")?.tools ?? []).map((item) =>
      tool(item.name, item.description, item.risk, item.risk === "read"),
    );
  }
  return [];
}

function tool(name: string, description: string, risk: ToolRisk, enabled: boolean): UiTool {
  return {
    name,
    description,
    risk,
    enabled,
    approval: risk === "read" ? "auto" : "ask",
    skipped: false,
  };
}

function previewConnectors(preview: string, connectors: ConnectorRecord[]): ConnectorRecord[] {
  if (preview === "empty" || preview === "loading" || preview === "catalog")
    return preview === "catalog" ? [] : [];
  if (preview === "connected")
    return [fixture("preview-notion", "Notion", "notion", "connected", "workspace")];
  if (preview === "reconnect" || preview === "error" || preview === "details") {
    return [
      fixture(
        "preview-drive",
        "Google Drive",
        "google-drive",
        "reconnect",
        null,
        "Sign-in expired 2 days ago. Tools are paused.",
      ),
      fixture(
        "preview-postgres",
        "Postgres",
        "postgres",
        "error",
        null,
        "URL just failed: connection refused",
      ),
    ];
  }
  if (preview === "manage" || preview === "disconnect") {
    return [fixture("preview-notion", "Notion", "notion", "connected", "workspace")];
  }
  return connectors;
}

function fixture(
  id: string,
  name: string,
  catalogId: string,
  status: "connected" | "error" | "reconnect",
  account: string | null,
  detail?: string,
): ConnectorRecord {
  const entry = catalogById(catalogId);
  const tools: Record<string, ConnectorToolSetting> = {};
  for (const item of entry?.tools ?? []) {
    tools[item.name] = {
      enabled: item.risk === "read",
      approval: item.risk === "read" ? "auto" : "ask",
      risk: item.risk,
      description: item.description,
      skipped: false,
    };
  }
  return {
    id,
    name,
    transport: "http",
    target: `https://catalog.mockbot.local/${catalogId}`,
    secretRef: null,
    enabled: true,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    catalogId,
    authType: "oauth",
    accountLabel: account,
    status,
    statusDetail: detail ?? null,
    tools,
    seenTools: Object.keys(tools),
    failures: [],
  };
}

/** Prefer the API's error text over a generic client fallback. */
export function serverProvidedError(
  body: { error?: unknown; message?: unknown } | null,
): string | null {
  if (!body) return null;
  if (typeof body.error === "string" && body.error.trim()) return body.error.trim();
  if (typeof body.message === "string" && body.message.trim()) return body.message.trim();
  return null;
}

export function connectorForActivity(
  connectors: readonly ConnectorRecord[],
  toolName: string,
): ConnectorRecord | undefined {
  const exact = connectors.filter((connector) => {
    const compact = connector.id.replace(/-/g, "");
    return toolName.endsWith(`_${compact}`) || toolName.endsWith(`_${compact.slice(0, 8)}`);
  });
  if (exact.length === 1) return exact[0];
  const full = exact.find((connector) => toolName.endsWith(`_${connector.id.replace(/-/g, "")}`));
  if (full) return full;
  let best: ConnectorRecord | undefined;
  let bestLength = 0;
  for (const connector of connectors) {
    const slug = connectorSlug(connector.name);
    if (toolName.startsWith(`${slug}_`) && slug.length > bestLength) {
      best = connector;
      bestLength = slug.length;
    }
  }
  return best;
}
