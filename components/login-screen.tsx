"use client";

import { useState, type FormEvent } from "react";
import { signInWithGoogle } from "../src/auth/actions";
import { Mochi } from "./mochi";
import { ThemeToggle } from "./theme";

const ERRORS: Record<string, string> = {
  OAuthAccountNotLinked:
    "An account with that email already exists. Sign in with your password instead.",
  GoogleSignInNotConfigured:
    "Google sign-in is not configured yet. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, then restart the server.",
  Configuration: "Google sign-in is not configured yet.",
  AccessDenied: "Google sign-in was cancelled.",
  Verification: "That sign-in link is invalid or has expired.",
};

function GoogleMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z"
      />
      <path
        fill="#FBBC05"
        d="M3.964 10.706A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.706V4.962H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.038l3.007-2.332z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.962L3.964 7.294C4.672 5.163 6.656 3.58 9 3.58z"
      />
    </svg>
  );
}

export function LoginScreen({
  initialError,
  nextPath,
}: {
  initialError?: string | null;
  nextPath: string;
}) {
  const [mode, setMode] = useState<"sign-in" | "sign-up">("sign-in");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(
    initialError ? (ERRORS[initialError] ?? "Could not sign in. Try again.") : null,
  );
  const [pending, setPending] = useState(false);
  const signUp = mode === "sign-up";

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          intent: mode,
          email,
          password,
          name: signUp ? name : undefined,
        }),
      });
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) {
        setError(body?.error ?? "Could not sign in.");
        setPending(false);
        return;
      }
      window.location.assign(nextPath);
    } catch {
      setError("Could not reach Mockbot. Try again.");
      setPending(false);
    }
  }

  return (
    <main className="auth-page">
      <div className="auth-tools">
        <ThemeToggle />
      </div>
      <section className="auth-card">
        <Mochi state="idle" size={56} label="Mochi" />
        <h1>{signUp ? "Create your account" : "Welcome back"}</h1>
        <p className="auth-lead">
          {signUp
            ? "Your chats, agents, and memory stay with this account."
            : "Sign in to your Mockbot workspace."}
        </p>
        <form action={signInWithGoogle}>
          <input type="hidden" name="next" value={nextPath} />
          <button type="submit" className="auth-google" disabled={pending}>
            <GoogleMark />
            Continue with Google
          </button>
        </form>
        <div className="auth-divider">
          <span>or</span>
        </div>
        <form className="auth-form" onSubmit={(event) => void onSubmit(event)}>
          {signUp ? (
            <label>
              Name
              <input
                name="name"
                autoComplete="name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={80}
              />
            </label>
          ) : null}
          <label>
            Email
            <input
              name="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>
          <label>
            Password
            <input
              name="password"
              type="password"
              autoComplete={signUp ? "new-password" : "current-password"}
              required
              minLength={10}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          {error ? (
            <p className="auth-error" role="alert">
              {error}
            </p>
          ) : null}
          <button type="submit" className="auth-submit" disabled={pending}>
            {pending ? "Please wait…" : signUp ? "Create account" : "Sign in"}
          </button>
        </form>
        <p className="auth-switch">
          {signUp ? "Already have an account?" : "New here?"}{" "}
          <button
            type="button"
            onClick={() => {
              setMode(signUp ? "sign-in" : "sign-up");
              setError(null);
            }}
          >
            {signUp ? "Sign in" : "Create an account"}
          </button>
        </p>
      </section>
    </main>
  );
}
