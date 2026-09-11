"use client";

// The sign-in screen — P1-49, in the Ember Grid language this time:
// centred glass card with the gradient rim, wordmark above it, mono
// eyebrow, Satoshi heading, the intake's own field and CTA. One field,
// because the email is the whole account. When no email provider is
// configured the link renders in the card — the resume screen's
// shown-on-screen precedent, kept honest for the pilot.

import { useState } from "react";
import Link from "next/link";

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

  return (
    <main className="auth-stage">
      <div className="auth-col">
        <span className="wordmark">Ledgerline</span>

        {phase === "sent" ? (
          <section className="card auth-card" aria-live="polite">
            <span className="auth-eyebrow">link sent</span>
            <h1 className="auth-title">Check your email.</h1>
            {screenLink ? (
              <>
                <p className="auth-copy">
                  Email sending isn&rsquo;t set up in this environment, so your sign-in link is
                  right here instead. It works once and expires in 15&nbsp;minutes.
                </p>
                <a className="next auth-cta" href={screenLink}>
                  Sign in now
                </a>
              </>
            ) : (
              <p className="auth-copy">
                A sign-in link is on its way to <strong>{email}</strong>. It works once and
                expires in 15&nbsp;minutes — you can close this tab.
              </p>
            )}
          </section>
        ) : (
          <section className="card auth-card">
            <span className="auth-eyebrow">sign in</span>
            <h1 className="auth-title">One link. No password.</h1>
            <p className="auth-copy">
              Your email is the whole account. New here? The same link signs you up — and keeps
              everything you&rsquo;ve already answered.
            </p>
            <form onSubmit={(e) => void submit(e)} className="auth-form">
              <input
                className="field"
                type="email"
                required
                autoFocus
                autoComplete="email"
                placeholder="you@business.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={phase === "sending"}
              />
              <button className="next auth-cta" type="submit" disabled={phase === "sending"}>
                {phase === "sending" ? "Sending…" : "Email me a sign-in link"}
              </button>
            </form>
            {error && <p className="auth-error">{error}</p>}
          </section>
        )}

        <p className="auth-foot">
          <Link href="/">← back to the front page</Link>
        </p>
      </div>
    </main>
  );
}
