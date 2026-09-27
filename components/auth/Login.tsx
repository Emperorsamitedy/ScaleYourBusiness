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
// The film fills the stage; the one form both entrances share floats
// centred over it. The SSO doors are real OAuth starts — a provider
// whose keys aren't set says so and points at the email path.

import { useState } from "react";
import Link from "next/link";
import { FadingVideo } from "../landing/cine/FadingVideo";

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

  const sso = (provider: string) => {
    window.location.href = `/api/auth/oauth/${provider}/start?from=${variant}`;
  };

  return (
    <main className="auth-hero">
      {/* ── the film fills the whole stage ── */}
      <FadingVideo src={FILM} className="auth-film" loop />
      <div className="auth-scrim" />
      <Link href="/" className="wordmark auth-wordmark auth-hero-mark">
        Ledgerline
      </Link>

      {/* ── the form floats centred over the scene ── */}
      <section className="auth-float">
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
                  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                    <path
                      fill="#EA4335"
                      d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38z"
                    />
                    <path
                      fill="#4285F4"
                      d="M23.49 12.27c0-.79-.07-1.54-.19-2.27H12v4.51h6.47c-.29 1.48-1.14 2.73-2.4 3.58l3.6 2.79c2.11-1.95 3.82-4.82 3.82-8.61z"
                    />
                    <path
                      fill="#FBBC05"
                      d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09L2.18 7.07C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"
                    />
                    <path
                      fill="#34A853"
                      d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.6-2.79c-.98.66-2.23 1.06-3.68 1.06-2.86 0-5.29-1.93-6.16-4.52l-3.66 2.84C3.99 20.53 7.7 23 12 23z"
                    />
                  </svg>
                  Continue with Google
                </button>
                <div className="sso-pair">
                  <button type="button" className="sso-btn" onClick={() => sso("apple")}>
                    <svg
                      viewBox="0 0 24 24"
                      width="18"
                      height="18"
                      fill="currentColor"
                      aria-hidden="true"
                    >
                      <path d="M16.36 12.76c-.02-2.05 1.68-3.03 1.75-3.08-.95-1.39-2.44-1.58-2.97-1.6-1.26-.13-2.47.74-3.11.74-.64 0-1.63-.72-2.68-.7-1.38.02-2.65.8-3.36 2.03-1.43 2.48-.37 6.15 1.03 8.17.68.99 1.49 2.1 2.56 2.06 1.03-.04 1.42-.66 2.66-.66 1.24 0 1.59.66 2.68.64 1.11-.02 1.81-1 2.48-2 .78-1.15 1.11-2.26 1.13-2.32-.03-.01-2.15-.83-2.17-3.28zM14.3 6.74c.57-.69.95-1.65.85-2.6-.82.03-1.8.54-2.39 1.23-.52.61-.98 1.58-.86 2.51.91.07 1.84-.46 2.4-1.14z" />
                    </svg>
                    Apple
                  </button>
                  <button type="button" className="sso-btn" onClick={() => sso("microsoft")}>
                    <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">
                      <rect x="2" y="2" width="9.5" height="9.5" fill="#F25022" />
                      <rect x="12.5" y="2" width="9.5" height="9.5" fill="#7FBA00" />
                      <rect x="2" y="12.5" width="9.5" height="9.5" fill="#00A4EF" />
                      <rect x="12.5" y="12.5" width="9.5" height="9.5" fill="#FFB900" />
                    </svg>
                    Microsoft
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
