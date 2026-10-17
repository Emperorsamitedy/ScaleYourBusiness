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
// One paper sheet on the desk (ux-spec §2), the form both entrances
// share. The SSO doors are real OAuth starts — a provider whose keys
// aren't set says so and points at the email path. They are named in
// words; the brands' logos would be the only icons on the screen.

import { useState } from "react";
import Link from "next/link";

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

  const sso = (provider: string) => {
    window.location.href = `/api/auth/oauth/${provider}/start?from=${variant}`;
  };

  return (
    <main className="auth-hero">
      <Link href="/" className="wordmark auth-wordmark auth-hero-mark">
        Ledgerline
      </Link>

      <section className="auth-float card">
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
              <div className="sso-row">
                <button type="button" className="sso-btn" onClick={() => sso("google")}>
                  Continue with Google
                </button>
                <div className="sso-pair">
                  <button type="button" className="sso-btn" onClick={() => sso("apple")}>
                    Continue with Apple
                  </button>
                  <button type="button" className="sso-btn" onClick={() => sso("microsoft")}>
                    Continue with Microsoft
                  </button>
                </div>
              </div>
              <div className="sso-or" aria-hidden="true">
                <span>or</span>
              </div>
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
              <p className="auth-nopass">We email you a one-time link.</p>

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
