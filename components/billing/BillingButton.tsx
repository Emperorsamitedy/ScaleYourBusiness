"use client";

// One billing action (POST /api/billing): a plan's checkout, the card,
// Watch, cancel, resume. A URL in the answer is followed; otherwise the
// page reloads to show the new state. Payments not switched on say so.

import { useState } from "react";

export function BillingButton({
  action,
  label,
  extra,
  words,
  className = "ghost",
}: {
  action: "subscribe" | "portal" | "downgrade" | "cancel" | "resume";
  label: string;
  extra?: Record<string, string>;
  words: { failed: string; notArmed: string };
  className?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function go() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/billing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...extra }),
      });
      if (res.status === 503) return setError(words.notArmed);
      if (!res.ok) return setError(words.failed);
      const body = (await res.json()) as { checkout_url?: string; url?: string };
      const next = body.checkout_url ?? body.url;
      if (next) window.location.assign(next);
      else window.location.reload();
    } catch {
      setError(words.failed);
    } finally {
      setBusy(false);
    }
  }
  return (
    <span className="billing-action">
      <button type="button" className={className} onClick={go} disabled={busy}>
        {label}
      </button>
      {error && <span role="alert"> {error}</span>}
    </span>
  );
}
