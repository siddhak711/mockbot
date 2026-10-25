"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { formatRunTime } from "../src/routines/format";
import type { Routine, RoutineRun, RoutineStatus } from "../src/routines/types";

type RoutineWithRuns = Routine & { runs: RoutineRun[] };

function triggerLabel(routine: Routine): string {
  if (routine.trigger.kind === "cron") return routine.trigger.cron;
  return routine.trigger.eventName;
}

function statusLabel(status: RoutineStatus | RoutineRun["status"]): string {
  if (status === "succeeded") return "Succeeded";
  if (status === "failed") return "Failed";
  if (status === "running") return "Running";
  if (status === "pending") return "Pending";
  if (status === "paused") return "Paused";
  return "Active";
}

export function RoutinesWorkspace() {
  const [routines, setRoutines] = useState<RoutineWithRuns[]>([]);
  const [navOpen, setNavOpen] = useState(false);
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [kind, setKind] = useState<"cron" | "event">("cron");
  const [cron, setCron] = useState("0 9 * * *");
  const [eventName, setEventName] = useState("");
  const [eventPayload, setEventPayload] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const response = await fetch("/api/routines");
    if (!response.ok) return;
    const data = (await response.json()) as { routines: RoutineWithRuns[] };
    setRoutines(data.routines);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const response = await fetch("/api/routines");
      if (!response.ok || cancelled) return;
      const data = (await response.json()) as { routines: RoutineWithRuns[] };
      if (!cancelled) setRoutines(data.routines);
    })();
    const timer = setInterval(() => {
      if (!cancelled) void load();
    }, 1000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [load]);

  async function createRoutine(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/routines", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          prompt,
          cron: kind === "cron" ? cron : undefined,
          eventName: kind === "event" ? eventName : undefined,
        }),
      });
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) {
        setError(body?.error ?? "Could not create routine");
        return;
      }
      setName("");
      setPrompt("");
      await load();
    } catch {
      setError("Could not create routine");
    } finally {
      setSaving(false);
    }
  }

  async function setStatus(routine: Routine, status: RoutineStatus) {
    setBusyId(routine.id);
    setError(null);
    try {
      const response = await fetch(`/api/routines/${routine.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? "Could not update routine");
        return;
      }
      await load();
    } catch {
      setError("Could not update routine");
    } finally {
      setBusyId(null);
    }
  }

  async function insertEvent(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/routines/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: eventName, payload: eventPayload }),
      });
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) {
        setError(body?.error ?? "Could not insert event");
        return;
      }
      setEventPayload("");
      await load();
    } catch {
      setError("Could not insert event");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="app">
      <aside className={navOpen ? "sidebar open" : "sidebar"}>
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
        <a className="new" href="/">
          Chat
        </a>
        <a className="new" href="/routines" aria-current="page">
          Routines
        </a>
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
          <h1>Routines</h1>
          <a className="icon-btn" href="/" aria-label="Back to chat">
            <ChatIcon />
          </a>
        </header>
        <header className="thread-header">
          <h1>Routines</h1>
          <a className="ghost-text" href="/">
            Chat
          </a>
        </header>
        <div className="routines-body">
          <div className="routines-column">
            <form className="routine-card" onSubmit={(event) => void createRoutine(event)}>
              <h2>New routine</h2>
              <label className="field">
                <span>Name</span>
                <input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  required
                  maxLength={80}
                />
              </label>
              <label className="field">
                <span>Prompt</span>
                <textarea
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  required
                  rows={4}
                  maxLength={20000}
                />
              </label>
              <fieldset className="choices">
                <legend>Trigger</legend>
                <label>
                  <input
                    type="radio"
                    name="trigger"
                    checked={kind === "cron"}
                    onChange={() => setKind("cron")}
                  />
                  Cron
                </label>
                <label>
                  <input
                    type="radio"
                    name="trigger"
                    checked={kind === "event"}
                    onChange={() => setKind("event")}
                  />
                  Event
                </label>
              </fieldset>
              {kind === "cron" ? (
                <label className="field">
                  <span>Cron schedule, UTC</span>
                  <input
                    aria-label="Cron schedule"
                    value={cron}
                    onChange={(event) => setCron(event.target.value)}
                    required
                    spellCheck={false}
                  />
                  <small>
                    Five fields: minute hour day month weekday. `0 9 * * 1` is Monday at 09:00 UTC.
                  </small>
                </label>
              ) : (
                <label className="field">
                  <span>Event name</span>
                  <input
                    aria-label="Event name"
                    value={eventName}
                    onChange={(event) => setEventName(event.target.value)}
                    required
                    spellCheck={false}
                  />
                </label>
              )}
              <button type="submit" className="primary-btn" disabled={saving}>
                Create routine
              </button>
            </form>

            {error ? (
              <p className="error" role="alert">
                {error}
              </p>
            ) : null}

            {routines.length === 0 ? (
              <p className="empty">No routines yet</p>
            ) : (
              <ul className="routine-list">
                {routines.map((routine) => (
                  <li key={routine.id} className="routine-card">
                    <div className="routine-head">
                      <h2>{routine.name}</h2>
                      <span className={`status-pill ${routine.status}`}>
                        {statusLabel(routine.status)}
                      </span>
                    </div>
                    <p className="routine-prompt">{routine.prompt}</p>
                    {routine.trigger.kind === "cron" ? (
                      <p className="next-run">
                        {routine.status === "active" && routine.nextRunAt ? (
                          <>
                            Next run{" "}
                            <time dateTime={routine.nextRunAt}>
                              {formatRunTime(routine.nextRunAt)}
                            </time>
                          </>
                        ) : (
                          "Paused. No further runs until you resume."
                        )}
                        <span className="routine-meta"> {triggerLabel(routine)} UTC</span>
                      </p>
                    ) : (
                      <p className="next-run">
                        Runs once when <code>{routine.trigger.eventName}</code> arrives.
                        {routine.status === "paused" ? " Paused." : null}
                      </p>
                    )}
                    <div className="routine-actions">
                      {routine.status === "active" ? (
                        <button
                          type="button"
                          className="ghost-text"
                          disabled={busyId === routine.id}
                          onClick={() => void setStatus(routine, "paused")}
                        >
                          Pause
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="ghost-text"
                          disabled={busyId === routine.id}
                          onClick={() => void setStatus(routine, "active")}
                        >
                          Resume
                        </button>
                      )}
                      {routine.conversationId ? (
                        <a className="ghost-text" href={`/?c=${routine.conversationId}`}>
                          Open conversation
                        </a>
                      ) : null}
                    </div>
                    <h3>Runs</h3>
                    {routine.runs.length === 0 ? (
                      <p className="empty">No runs yet</p>
                    ) : (
                      <ul className="run-list" aria-live="polite">
                        {routine.runs.map((run) => (
                          <li key={run.id} className="run-row">
                            <span className={`status-pill ${run.status}`}>
                              {statusLabel(run.status)}
                            </span>
                            <time dateTime={run.scheduledFor}>
                              {formatRunTime(run.scheduledFor)}
                            </time>
                            {run.error ? <span className="run-error">{run.error}</span> : null}
                            {run.resultExcerpt ? (
                              <span className="run-excerpt">{run.resultExcerpt}</span>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
            )}

            <form className="routine-card" onSubmit={(event) => void insertEvent(event)}>
              <h2>Insert event</h2>
              <p className="routine-meta">
                An active event routine with this name runs once. Inserting it again schedules
                another run.
              </p>
              <label className="field">
                <span>Event name</span>
                <input
                  aria-label="Event to insert"
                  value={eventName}
                  onChange={(event) => setEventName(event.target.value)}
                  required
                />
              </label>
              <label className="field">
                <span>Payload, optional</span>
                <textarea
                  aria-label="Event payload"
                  value={eventPayload}
                  onChange={(event) => setEventPayload(event.target.value)}
                  rows={2}
                />
              </label>
              <button type="submit" className="primary-btn" disabled={saving}>
                Insert event
              </button>
            </form>
          </div>
        </div>
      </main>
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

function ChatIcon() {
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
      <path d="M5 6h14v9H8l-3 3V6Z" strokeLinejoin="round" />
    </svg>
  );
}
