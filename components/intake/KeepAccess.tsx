"use client";

// P1-56: a way back in. No password — an email and a link that reopens
// the profile on any device. The link is shown on screen rather than
// promised by email, because a promised email that never arrives is worse
// than no promise. Used by the done card and by the masthead's
// "Pause — finish later".

import { useState } from "react";

export function KeepAccess() {
  const [email, setEmail] = useState("");
  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (busy || email.trim() === "") return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/intake/resume", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const payload = (await res.json()) as { url?: string; error?: string };
      if (!res.ok) {
        setError(payload.error ?? "I couldn't make the link. Try again.");
        return;
      }
      setLink(payload.url ?? null);
    } catch {
      setError("I couldn't reach the server. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  };

  if (link) {
    return (
      <div className="ix-linkbox inset">
        <span className="ix-cap">Your link</span> It reopens this profile on any device for 30 days.
        Keep a copy somewhere you&rsquo;ll find it.
        <code>{link}</code>
      </div>
    );
  }

  return (
    <form className="ix-finish" onSubmit={(e) => void submit(e)}>
      <input
        className="ix-input"
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="you@yourbusiness.hu"
        aria-label="Your email address"
      />
      <button type="submit" className="act solid" disabled={busy || email.trim() === ""}>
        {busy ? "Making the link" : <>Get my link &rarr;</>}
      </button>
      {error && <p className="ix-err">{error}</p>}
    </form>
  );
}
