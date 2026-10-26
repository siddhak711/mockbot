"use client";

import { useState, type FormEvent } from "react";
import { WAITLIST_IDLE, waitlistMessage } from "../../src/landing/waitlist";

export function WaitlistForm({ id }: { id: string }) {
  const [message, setMessage] = useState(WAITLIST_IDLE);
  const [error, setError] = useState(false);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const input = event.currentTarget.elements.namedItem("email");
    const email = input instanceof HTMLInputElement ? input.value : "";
    const result = waitlistMessage(email);
    setMessage(result.text);
    setError(!result.ok);
  }

  return (
    <div className="wlwrap">
      <form className="wl" noValidate onSubmit={onSubmit}>
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
        />
        <button type="submit">
          <span>Join waitlist</span>
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
