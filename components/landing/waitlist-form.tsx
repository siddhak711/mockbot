"use client";

import { useState, type FormEvent } from "react";
import {
  WAITLIST_FAILED,
  WAITLIST_IDLE,
  WAITLIST_INVALID,
  WAITLIST_PENDING,
  normalizeWaitlistEmail,
  waitlistJoinedMessage,
} from "../../src/landing/waitlist";

export function WaitlistForm({ id }: { id: string }) {
  const [message, setMessage] = useState(WAITLIST_IDLE);
  const [error, setError] = useState(false);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const input = event.currentTarget.elements.namedItem("email");
    const email = normalizeWaitlistEmail(input instanceof HTMLInputElement ? input.value : "");
    if (!email) {
      setMessage(WAITLIST_INVALID);
      setError(true);
      return;
    }
    setPending(true);
    setError(false);
    setMessage(WAITLIST_PENDING);
    try {
      const response = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (response.ok) {
        setMessage(waitlistJoinedMessage(email));
      } else {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        setMessage(body?.error || WAITLIST_FAILED);
        setError(true);
      }
    } catch {
      setMessage(WAITLIST_FAILED);
      setError(true);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="wlwrap">
      <form className="wl" noValidate onSubmit={onSubmit} aria-busy={pending}>
        <label className="sr" htmlFor={id}>
          Email address
        </label>
        <input
          id={id}
          name="email"
          type="email"
          placeholder="you@domain.com"
          autoComplete="email"
          required
          disabled={pending}
        />
        <button type="submit" disabled={pending}>
          <span>{pending ? "Joining…" : "Join waitlist"}</span>
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M3 8h10M9 4l4 4-4 4" />
          </svg>
        </button>
      </form>
      <p className={error ? "msg err" : "msg"} aria-live="polite">
        {message}
      </p>
    </div>
  );
}
