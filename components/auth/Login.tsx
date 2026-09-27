"use client";

// The sign-in / sign-up screen — P1-49, cinematic split.
//
// There are no passwords here, so there is no "forgot password" — the
// emailed one-shot link is the key, every time. Sign-up and sign-in
// are the same motion (the link creates the account the first time an
// email proves itself), but they are two ENTRANCES: /login and /signup
// render this same screen with copy that meets each visitor where they
// arrived, because a stranger looking for "create account" should find
// those words, not a riddle.
//
// Left: the landing's film bed with the system visibly working — a
// looped question → recorded fact → provable finding demo. Right: the
// one form both entrances share.

import { useState } from "react";
import Link from "next/link";
import { FadingVideo } from "../landing/cine/FadingVideo";
import { SystemDemo } from "./SystemDemo";

const FILM =
  "https://d8j0ntlcm91z4.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/hf_20260328_105406_16f4600d-7a92-4292-b96e-b19156c7830a.mp4";

type Phase = "form" | "sending" | "sent";

export function LoginScreen({ variant = "signin" }: { variant?: "signin" | "signup" }) {
  const [email, setEmail] = useState("");
  const [phase, setPhase] = useState<Phase>("form");
  const [error, setError] = useState<string | null>(
    typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("error") : null,
  );
  const [screenLink, setScreenLink] = useState<string | null>(null);

  const signup = variant === "signup";

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
      {/* ── the film + the system working ── */}
      <section className="auth-cine" aria-hidden="true">
        <FadingVideo src={FILM} className="auth-film" loop />
        <div className="auth-scrim" />
        <div className="auth-cine-inner">
          <Link href="/" className="wordmark auth-wordmark">
            Ledgerline
          </Link>
          <SystemDemo />
          <div className="auth-statement">
            <h2>Your business, actually understood.</h2>
          </div>
        </div>
      </section>

      {/* ── the form ── */}
      <section className="auth-panel">
        <div className="auth-panel-inner">
          {phase === "sent" ? (
            <div aria-live="polite">
              <h1 className="auth-title">Check your email.</h1>
              {screenLink ? (
                <>
                  <p className="auth-copy">
                    Email isn&rsquo;t configured here, so your one-time link is below. It expires in
                    15&nbsp;minutes.
                  </p>
                  <a className="next auth-cta" href={screenLink}>
                    {signup ? "Create my account" : "Sign in now"}
                  </a>
                </>
              ) : (
                <p className="auth-copy">
                  We sent a one-time link to <strong>{email}</strong>. It expires in
                  15&nbsp;minutes.
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
              <h1 className="auth-title">{signup ? "Create your account" : "Sign in"}</h1>
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
                  {phase === "sending"
                    ? "Sending…"
                    : signup
                      ? "Create my account"
                      : "Email me a sign-in link"}
                </button>
              </form>
              {error && <p className="auth-error">{error}</p>}

              {/* The answer to "forgot password?", where the eye expects it. */}
              <p className="auth-nopass">No password — we email you a one-time link.</p>

              <p className="auth-foot" style={{ marginTop: 24 }}>
                {signup ? (
                  <>
                    Already have an account? <Link href="/login">Sign in</Link>
                  </>
                ) : (
                  <>
                    New here? <Link href="/signup">Create your account</Link>
                  </>
                )}
              </p>
            </div>
          )}
        </div>
      </section>
    </main>
  );
}
