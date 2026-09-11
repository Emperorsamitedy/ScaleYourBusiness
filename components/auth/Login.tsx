"use client";

// The sign-in screen — P1-49, third pass: the cinematic split.
//
// Left: the landing's looping film bed under an ember scrim, with the
// product's statement in Satoshi — the same world the owner arrived
// from. Right: the form, quiet and single-purpose. Sign-up and sign-in
// are one motion (an email and a signed link), so there is exactly one
// screen for both and the copy says so.
//
// On mobile the film collapses to a short band above the form; the
// form never competes with the picture for the viewport.

import { useState } from "react";
import Link from "next/link";
import { FadingVideo } from "../landing/cine/FadingVideo";

// The landing's scroll bed — looping, dimmed, already fades itself in.
const FILM =
  "https://d8j0ntlcm91z4.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/hf_20260328_105406_16f4600d-7a92-4292-b96e-b19156c7830a.mp4";

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
    <main className="auth-split">
      {/* ── the film ── */}
      <section className="auth-cine" aria-hidden="true">
        <FadingVideo src={FILM} className="auth-film" loop />
        <div className="auth-scrim" />
        <div className="auth-cine-inner">
          <Link href="/" className="wordmark auth-wordmark">
            Ledgerline
          </Link>
          <div className="auth-statement">
            <span className="auth-eyebrow">the business operating system</span>
            <h2>
              Your business,
              <br />
              actually understood.
            </h2>
            <p className="auth-cine-line">
              Every number you give it keeps its source. Every claim it makes shows its work.
            </p>
          </div>
        </div>
      </section>

      {/* ── the form ── */}
      <section className="auth-panel">
        <div className="auth-panel-inner">
          {phase === "sent" ? (
            <div aria-live="polite">
              <span className="auth-eyebrow">link sent</span>
              <h1 className="auth-title">Check your email.</h1>
              {screenLink ? (
                <>
                  <p className="auth-copy">
                    Email sending isn&rsquo;t set up in this environment, so your sign-in link
                    is right here instead. It works once and expires in 15&nbsp;minutes.
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
              <p className="auth-foot" style={{ marginTop: 28 }}>
                Wrong address?{" "}
                <button className="auth-linkish" onClick={() => setPhase("form")}>
                  Send another link
                </button>
              </p>
            </div>
          ) : (
            <div>
              <span className="auth-eyebrow">sign in · sign up</span>
              <h1 className="auth-title">One link. No password.</h1>
              <p className="auth-copy">
                Your email is the whole account. New here? The same link signs you up — and
                keeps everything you&rsquo;ve already answered.
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
              <p className="auth-foot" style={{ marginTop: 34 }}>
                <Link href="/">← back to the front page</Link>
              </p>
            </div>
          )}
        </div>
      </section>
    </main>
  );
}
