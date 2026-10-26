"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";

function OauthConsent() {
  const params = useSearchParams();
  const name = params.get("name") || "Connector";

  function finish(ok: boolean) {
    const opener = window.opener as Window | null;
    opener?.postMessage(
      { type: "mockbot-oauth", ok, account: "workspace" },
      window.location.origin,
    );
    window.close();
  }

  return (
    <main className="oauth-page">
      <h1>Sign in to {name}</h1>
      <p className="t2">mockbot will use the pages you allow. It never sees your password.</p>
      <div className="pair">
        <button type="button" className="btn ghost" onClick={() => finish(false)}>
          Deny
        </button>
        <button type="button" className="btn primary" onClick={() => finish(true)}>
          Allow
        </button>
      </div>
    </main>
  );
}

export default function OauthPage() {
  return (
    <Suspense>
      <OauthConsent />
    </Suspense>
  );
}
