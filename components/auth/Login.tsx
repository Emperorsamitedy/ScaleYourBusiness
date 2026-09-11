"use client";

// The sign-in screen — P1-49. One field. Requesting a link for a new
// email IS signup; there is nothing else to fill in. When no email
// provider is configured the link renders here instead — the resume
// screen's shown-on-screen precedent, kept honest for the pilot.

import { useState } from "react";

type Phase = "form" | "sending" | "sent";

export function LoginScreen() {
  const [email, setEmail] = useState("");
  const [phase, setPhase] = useState<Phase>("form");
  const [error, setError] = useState<string | null>(
    typeof window !== "undefined"
      ? new URLSearchParams(window.location.search).get("error")
      : null,
  );
  const [screenLink, setScreenLink] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setPhase("sending");
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const payload = (await res.json()) as {
        error?: string;
        delivered_via?: string;
        link?: string;
      };
      if (!res.ok) {
        setError(payload.error ?? "something went wrong");
        setPhase("form");
        return;
      }
      setScreenLink(payload.link ?? null);
      setPhase("sent");
    } catch {
      setError("I couldn't reach the server — try again.");
      setPhase("form");
    }
  };

  if (phase === "sent") {
    return (
      <main className="rp-shell">
        <div className="rp-none">
          <h1>Check your email.</h1>
          {screenLink ? (
            <>
              <p>
                Email sending isn&rsquo;t set up in this environment, so here is your sign-in link
                directly — it works once and expires in 15 minutes.
              </p>
              <div className="rp-actions" style={{ maxWidth: 420 }}>
                <a className="rp-act" href={screenLink}>
                  Sign in now
                </a>
              </div>
            </>
          ) : (
            <p>
              A sign-in link is on its way to <strong>{email}</strong>. It works once and expires
              in 15 minutes. You can close this tab.
            </p>
          )}
        </div>
      </main>
    );
  }

  return (
    <main className="rp-shell">
      <div className="rp-none">
        <h1>Sign in.</h1>
        <p>
          Your email is the whole account — no password. New here? The same link signs you up and
          keeps everything you&rsquo;ve already answered.
        </p>
        <form onSubmit={(e) => void submit(e)} className="rp-actions" style={{ maxWidth: 420 }}>
          <input
            type="email"
            required
            autoFocus
            placeholder="you@business.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={phase === "sending"}
            style={{
              width: "100%",
              padding: "12px 14px",
              borderRadius: 10,
              border: "1px solid rgba(255,255,255,.14)",
              background: "rgba(255,255,255,.04)",
              color: "inherit",
              font: "inherit",
            }}
          />
          <button className="rp-act" type="submit" disabled={phase === "sending"}>
            {phase === "sending" ? "Sending…" : "Email me a sign-in link"}
          </button>
        </form>
        {error && <p style={{ color: "var(--ember, #f59b4b)", marginTop: 12 }}>{error}</p>}
      </div>
    </main>
  );
}
