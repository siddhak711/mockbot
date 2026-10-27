"use client";

import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { signOutAction } from "../src/auth/actions";
import type { AccountInfo } from "../src/auth/account";
import type { SignedInUser } from "../src/auth/user";
import type { Agent, AgentGrant } from "../src/agents/types";
import { SETTINGS_SECTIONS as SECTIONS, type SettingsSection } from "../src/settings";
import { spriteColorForAgent } from "../src/sprite";
import { runtimeStatusLabel, type RuntimeStatus } from "../src/token-stream";
import type { ThemePreference } from "../src/theme";
import { BotSprite } from "./bot-sprite";
import { ChatIcon, MenuIcon, TrafficLights } from "./icons";
import { useTheme } from "./theme";

type AgentWithGrants = Agent & { grants?: AgentGrant[] };

type ConnectorOption = { id: string; name: string };

function idsOf(grants: AgentGrant[] | undefined, kind: AgentGrant["kind"]): string[] {
  return (grants ?? []).filter((grant) => grant.kind === kind).map((grant) => grant.resourceId);
}

async function errorFrom(response: Response, fallback: string): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? fallback;
}

export function SettingsWorkspace({
  user,
  initialSection = "agents",
}: {
  user: SignedInUser;
  initialSection?: SettingsSection;
}) {
  const [section, setSection] = useState<SettingsSection>(initialSection);
  const [navOpen, setNavOpen] = useState(false);
  const title = SECTIONS.find((item) => item.id === section)?.label ?? "Settings";

  function choose(next: SettingsSection) {
    setSection(next);
    setNavOpen(false);
    const url = new URL(window.location.href);
    url.searchParams.set("section", next);
    window.history.replaceState(null, "", url);
  }

  return (
    <div className="app settings-app">
      <aside className={navOpen ? "sidebar open" : "sidebar"} aria-label="Settings">
        <div className="side-head">
          <TrafficLights />
          <span className="grow" />
        </div>
        <a className="nav-action" href="/">
          <ChatIcon />
          Back to chat
        </a>
        <div className="label">Settings</div>
        <nav className="settings-nav">
          {SECTIONS.map((item) => (
            <button
              key={item.id}
              type="button"
              className="nav-action"
              aria-current={item.id === section ? "page" : undefined}
              onClick={() => choose(item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>
      </aside>
      <button
        type="button"
        className={navOpen ? "scrim on" : "scrim"}
        aria-label="Close menu"
        tabIndex={navOpen ? 0 : -1}
        onClick={() => setNavOpen(false)}
      />
      <main className="main">
        <header className="top">
          <button
            type="button"
            className="icon-btn"
            aria-label="Open menu"
            aria-expanded={navOpen}
            onClick={() => setNavOpen(true)}
          >
            <MenuIcon />
          </button>
          <h1>{title}</h1>
          <a className="icon-btn" href="/" aria-label="Back to chat">
            <ChatIcon />
          </a>
        </header>
        <header className="thread-header">
          <h1>
            <span className="thread-title">{title}</span>
          </h1>
        </header>
        <div className="settings-body">
          <div className="settings-column">
            {section === "agents" ? <AgentsSection /> : null}
            {section === "account" ? <AccountSection user={user} /> : null}
            {section === "appearance" ? <AppearanceSection /> : null}
            {section === "workspace" ? <WorkspaceSection /> : null}
          </div>
        </div>
      </main>
    </div>
  );
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="routine-card settings-card" aria-label={title}>
      <h2>{title}</h2>
      {children}
    </section>
  );
}

function Notice({ error, saved }: { error: string | null; saved: string | null }) {
  if (error) {
    return (
      <p className="agent-error" role="alert">
        {error}
      </p>
    );
  }
  if (saved) {
    return (
      <p className="settings-saved" role="status">
        {saved}
      </p>
    );
  }
  return null;
}

function AgentsSection() {
  const [agents, setAgents] = useState<AgentWithGrants[] | null>(null);
  const [connectors, setConnectors] = useState<ConnectorOption[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [agentResponse, connectorResponse] = await Promise.all([
      fetch("/api/agents"),
      fetch("/api/connectors"),
    ]);
    if (agentResponse.ok) {
      const data = (await agentResponse.json()) as { agents: AgentWithGrants[] };
      setAgents(data.agents);
      setSelectedId((current) =>
        current && data.agents.some((agent) => agent.id === current)
          ? current
          : (data.agents[0]?.id ?? null),
      );
    } else {
      setAgents([]);
    }
    if (connectorResponse.ok) {
      const data = (await connectorResponse.json()) as { connectors: ConnectorOption[] };
      setConnectors(data.connectors.map(({ id, name }) => ({ id, name })));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (agents === null) return <p className="empty">Loading agents…</p>;
  if (agents.length === 0) return <p className="empty">No agents yet.</p>;
  const selected = agents.find((agent) => agent.id === selectedId) ?? agents[0]!;

  return (
    <>
      <div className="settings-agent-picker" role="group" aria-label="Agents">
        {agents.map((agent) => (
          <button
            key={agent.id}
            type="button"
            className={agent.id === selected.id ? "settings-agent on" : "settings-agent"}
            aria-pressed={agent.id === selected.id}
            onClick={() => setSelectedId(agent.id)}
          >
            <BotSprite state="idle" color={spriteColorForAgent(agent)} size={32} />
            <span>{agent.name}</span>
          </button>
        ))}
      </div>
      <AgentEditor key={selected.id} agent={selected} connectors={connectors} onChanged={load} />
    </>
  );
}

function AgentEditor({
  agent,
  connectors,
  onChanged,
}: {
  agent: AgentWithGrants;
  connectors: ConnectorOption[];
  onChanged: () => Promise<void>;
}) {
  const [name, setName] = useState(agent.name);
  const [instructions, setInstructions] = useState(agent.instructions);
  const [memoryNote, setMemoryNote] = useState(agent.memoryNote);
  const [computers, setComputers] = useState(idsOf(agent.grants, "computer").join(", "));
  const [connectorIds, setConnectorIds] = useState<string[]>(idsOf(agent.grants, "connector"));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  // Grants can name a connector that was since removed. Keep it visible so saving doesn't drop it silently.
  const options: ConnectorOption[] = [
    ...connectors,
    ...connectorIds
      .filter((id) => !connectors.some((connector) => connector.id === id))
      .map((id) => ({ id, name: id })),
  ];

  async function save(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    setSaved(null);
    try {
      const response = await fetch(`/api/agents/${encodeURIComponent(agent.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          instructions,
          memoryNote,
          computerIds: computers
            .split(",")
            .map((id) => id.trim())
            .filter(Boolean),
          connectorIds,
        }),
      });
      if (!response.ok) {
        setError(await errorFrom(response, "Couldn't save this agent."));
        return;
      }
      setSaved("Saved.");
      await onChanged();
    } catch {
      setError("Couldn't save this agent.");
    } finally {
      setPending(false);
    }
  }

  async function remove() {
    setPending(true);
    setError(null);
    try {
      const response = await fetch(`/api/agents/${encodeURIComponent(agent.id)}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        setError(await errorFrom(response, "Couldn't delete this agent."));
        setConfirming(false);
        return;
      }
      await onChanged();
    } catch {
      setError("Couldn't delete this agent.");
    } finally {
      setPending(false);
    }
  }

  return (
    <Card title={agent.isLead ? `${agent.name} (lead)` : agent.name}>
      <form className="settings-form" onSubmit={(event) => void save(event)}>
        <label className="field">
          <span>Name</span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={48}
            required
            disabled={pending}
          />
        </label>
        <label className="field">
          <span>Instructions</span>
          <textarea
            value={instructions}
            onChange={(event) => setInstructions(event.target.value)}
            rows={8}
            maxLength={4000}
            required
            disabled={pending}
          />
        </label>
        <label className="field">
          <span>Memory note</span>
          <textarea
            value={memoryNote}
            onChange={(event) => setMemoryNote(event.target.value)}
            rows={3}
            maxLength={2000}
            placeholder="Optional note only this agent can use"
            disabled={pending}
          />
        </label>
        <label className="field">
          <span>Computers</span>
          <input
            value={computers}
            onChange={(event) => setComputers(event.target.value)}
            placeholder="Computer ids, separated by commas"
            spellCheck={false}
            disabled={pending}
          />
        </label>
        <fieldset className="settings-checks">
          <legend>Connectors</legend>
          {options.length === 0 ? (
            <p className="empty">
              No connectors yet. Add one from <a href="/connectors">Connectors</a>.
            </p>
          ) : (
            options.map((connector) => (
              <label key={connector.id}>
                <input
                  type="checkbox"
                  checked={connectorIds.includes(connector.id)}
                  disabled={pending}
                  onChange={(event) =>
                    setConnectorIds((current) =>
                      event.target.checked
                        ? [...current, connector.id]
                        : current.filter((id) => id !== connector.id),
                    )
                  }
                />
                {connector.name}
              </label>
            ))
          )}
        </fieldset>
        <Notice error={error} saved={saved} />
        <div className="settings-actions">
          <button type="submit" className="primary-btn" disabled={pending}>
            Save changes
          </button>
          <span className="grow" />
          {agent.isLead ? (
            <span className="settings-hint">The lead agent can't be deleted.</span>
          ) : confirming ? (
            <>
              <span className="settings-hint">
                Delete {agent.name}? Its chat and memories go with it.
              </span>
              <button
                type="button"
                className="btn secondary"
                disabled={pending}
                onClick={() => setConfirming(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn danger"
                disabled={pending}
                onClick={() => void remove()}
              >
                Delete
              </button>
            </>
          ) : (
            <button
              type="button"
              className="btn secondary settings-delete"
              disabled={pending}
              onClick={() => setConfirming(true)}
            >
              Delete agent
            </button>
          )}
        </div>
      </form>
    </Card>
  );
}

function AccountSection({ user }: { user: SignedInUser }) {
  const [account, setAccount] = useState<AccountInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [name, setName] = useState(user.name ?? "");
  const [nameError, setNameError] = useState<string | null>(null);
  const [nameSaved, setNameSaved] = useState<string | null>(null);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordSaved, setPasswordSaved] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const response = await fetch("/api/account");
      if (cancelled) return;
      if (!response.ok) {
        setLoadError(await errorFrom(response, "Couldn't load your account."));
        return;
      }
      const data = (await response.json()) as { account: AccountInfo };
      if (cancelled) return;
      setAccount(data.account);
      setName(data.account.name ?? "");
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function saveName(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setNameError(null);
    setNameSaved(null);
    try {
      const response = await fetch("/api/account", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!response.ok) {
        setNameError(await errorFrom(response, "Couldn't save your name."));
        return;
      }
      const data = (await response.json()) as { name: string };
      setName(data.name);
      setNameSaved("Saved.");
    } catch {
      setNameError("Couldn't save your name.");
    } finally {
      setPending(false);
    }
  }

  async function savePassword(event: FormEvent) {
    event.preventDefault();
    setPasswordError(null);
    setPasswordSaved(null);
    if (next !== confirm) {
      setPasswordError("The new passwords don't match.");
      return;
    }
    setPending(true);
    try {
      const response = await fetch("/api/account/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ current, next }),
      });
      if (!response.ok) {
        setPasswordError(await errorFrom(response, "Couldn't change your password."));
        return;
      }
      setCurrent("");
      setNext("");
      setConfirm("");
      setPasswordSaved("Password changed. Other devices were signed out.");
    } catch {
      setPasswordError("Couldn't change your password.");
    } finally {
      setPending(false);
    }
  }

  const label = name.trim() || user.email;
  const methods = [
    ...(account?.hasPassword ? ["Email and password"] : []),
    ...(account?.providers ?? []).map((provider) =>
      provider === "google" ? "Google" : provider.charAt(0).toUpperCase() + provider.slice(1),
    ),
  ];

  return (
    <>
      <Card title="Profile">
        <div className="settings-profile">
          {user.image ? (
            <img className="ava ava-img" src={user.image} alt="" referrerPolicy="no-referrer" />
          ) : (
            <span className="ava" aria-hidden="true">
              {label.charAt(0).toUpperCase() || "?"}
            </span>
          )}
          <div className="settings-profile-copy">
            <strong>{label}</strong>
            <span>{account?.email ?? user.email}</span>
          </div>
        </div>
        {loadError ? (
          <p className="agent-error" role="alert">
            {loadError}
          </p>
        ) : null}
        <form className="settings-form" onSubmit={(event) => void saveName(event)}>
          <label className="field">
            <span>Name</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={80}
              required
              disabled={pending}
            />
          </label>
          <Notice error={nameError} saved={nameSaved} />
          <div className="settings-actions">
            <button type="submit" className="primary-btn" disabled={pending}>
              Save name
            </button>
          </div>
        </form>
      </Card>
      <Card title="Sign-in">
        <dl className="settings-facts">
          <dt>Email</dt>
          <dd>{account?.email ?? user.email}</dd>
          <dt>Signs in with</dt>
          <dd>{account ? methods.join(", ") || "Unknown" : "…"}</dd>
        </dl>
        {account?.hasPassword ? (
          <form className="settings-form" onSubmit={(event) => void savePassword(event)}>
            <h3>Change password</h3>
            <label className="field">
              <span>Current password</span>
              <input
                type="password"
                autoComplete="current-password"
                value={current}
                onChange={(event) => setCurrent(event.target.value)}
                required
                disabled={pending}
              />
            </label>
            <label className="field">
              <span>New password</span>
              <input
                type="password"
                autoComplete="new-password"
                minLength={10}
                value={next}
                onChange={(event) => setNext(event.target.value)}
                required
                disabled={pending}
              />
              <small>At least 10 characters.</small>
            </label>
            <label className="field">
              <span>Confirm new password</span>
              <input
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(event) => setConfirm(event.target.value)}
                required
                disabled={pending}
              />
            </label>
            <Notice error={passwordError} saved={passwordSaved} />
            <div className="settings-actions">
              <button type="submit" className="primary-btn" disabled={pending}>
                Change password
              </button>
            </div>
          </form>
        ) : null}
        <form action={signOutAction} className="settings-actions">
          <button type="submit" className="btn secondary">
            Log out
          </button>
        </form>
      </Card>
    </>
  );
}

const THEME_CHOICES: Array<{ id: ThemePreference; label: string; detail: string }> = [
  { id: "system", label: "System", detail: "Match this device's light or dark setting." },
  { id: "light", label: "Light", detail: "Always light." },
  { id: "dark", label: "Dark", detail: "Always dark." },
];

function AppearanceSection() {
  const { preference, setPreference } = useTheme();
  return (
    <Card title="Theme">
      <div className="settings-themes" role="radiogroup" aria-label="Theme">
        {THEME_CHOICES.map((choice) => (
          <label
            key={choice.id}
            className={preference === choice.id ? "settings-theme on" : "settings-theme"}
          >
            <input
              type="radio"
              name="theme"
              checked={preference === choice.id}
              onChange={() => setPreference(choice.id)}
            />
            <span className={`settings-swatch ${choice.id}`} aria-hidden="true" />
            <span className="settings-theme-copy">
              <strong>{choice.label}</strong>
              <span>{choice.detail}</span>
            </span>
          </label>
        ))}
      </div>
      <p className="settings-hint">
        Saved in this browser. The sun and moon button in the sidebar changes it too.
      </p>
    </Card>
  );
}

function WorkspaceSection() {
  const [status, setStatus] = useState<RuntimeStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const response = await fetch("/api/status");
      if (cancelled) return;
      if (!response.ok) {
        setError("Couldn't read the workspace status.");
        return;
      }
      const data = (await response.json()) as {
        provider: string;
        model: string | null;
        database?: string;
      };
      if (cancelled) return;
      setStatus({
        provider: data.provider,
        model: data.model,
        database: data.database === "neon" ? "neon" : "local",
      });
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const label = status ? runtimeStatusLabel(status) : null;

  return (
    <>
      <Card title="Model">
        {error ? (
          <p className="agent-error" role="alert">
            {error}
          </p>
        ) : (
          <dl className="settings-facts">
            <dt>Provider</dt>
            <dd>{status ? status.provider : "…"}</dd>
            <dt>Model</dt>
            <dd>{status ? (status.model ?? "None") : "…"}</dd>
            <dt>Database</dt>
            <dd>
              {status
                ? status.database === "neon"
                  ? "Neon Postgres"
                  : "Local Postgres (PGlite)"
                : "…"}
            </dd>
            {label ? (
              <>
                <dt>Summary</dt>
                <dd>{label.full}</dd>
              </>
            ) : null}
          </dl>
        )}
        <p className="settings-hint">
          The model and database come from the server&apos;s environment and can&apos;t be changed
          here.
        </p>
      </Card>
      <Card title="Workspace">
        <ul className="settings-links">
          <li>
            <a href="/connectors">Connectors</a>
            <span>Apps and tools your agents can use.</span>
          </li>
          <li>
            <a href="/routines">Routines</a>
            <span>Prompts that run on a schedule or when an event arrives.</span>
          </li>
        </ul>
      </Card>
    </>
  );
}
