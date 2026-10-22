"use client";

// The sign-in / sign-up screen — P1-49, on the sheet system (ux-spec §2).
//
// There are no passwords here, so there is no "forgot password" — the
// emailed one-shot link is the key, every time. Sign-up and sign-in
// are the same motion (the link creates the account the first time an
// email proves itself), but they are two ENTRANCES: /login and /signup
// render this same screen with copy that meets each visitor where they
// arrived, because a stranger looking for "create account" should find
// those words, not a riddle.
//
// The desk carries the promise (a ruled list on sign-in, the steps after
// this screen on sign-up); one paper sheet carries the form both
// entrances share. The SSO doors are real OAuth starts — a provider
// whose keys aren't set says so and points at the email path. They are
// named in words; the brands' logos would be the only icons on the
// screen.

import { useState } from "react";
import Link from "next/link";
import { BROWSER_PREFILL } from "../../lib/intake/browser-prefill";
import { DELIVERY_DAYS } from "../../lib/marketing/offer";
import { AuthMasthead } from "./AuthMasthead";
import "../../app/auth.css";

type Phase = "form" | "sending" | "sent";

// Mirrors LOGIN_TTL_MINUTES in lib/auth/service.ts. That module pulls in
// the database and node:crypto, so it cannot be imported into a client
// component; change both together.
const LINK_TTL_MINUTES = 15;

// The website address is not part of the login API (email only). It is
// kept in this browser and offered back as a draft in the intake's website
// question (lib/intake/browser-prefill.ts names the key).
const PENDING_STORE_KEY = BROWSER_PREFILL["presence.website_url"]!;

const SSO_PROVIDERS = [
  { id: "google", label: "Google" },
  { id: "apple", label: "Apple" },
  { id: "microsoft", label: "Microsoft" },
] as const;

const SIGNUP_STEPS: { n: string; text: string; takes: string }[] = [
  { n: "01", text: "Connect your accounts, read-only", takes: "2 min" },
  { n: "02", text: "Answer the core questions", takes: "~12 min" },
  {
    n: "03",
    text: "We read your numbers and sign the report",
    // "[7]" is the design's stand-in, shown until the owner sets DELIVERY_DAYS.
    takes: DELIVERY_DAYS === null ? "[7] days" : `${DELIVERY_DAYS} days`,
  },
];

const SIGNIN_POINTS = [
  "Nothing runs in your business without your approval.",
  "Every number shows where it came from.",
  "Nothing is ever erased — old facts are superseded and kept.",
];

function Arrow() {
  return (
    <span className="au-arrow" aria-hidden="true">
      &rarr;
    </span>
  );
}

function rememberStore(value: string) {
  try {
    const v = value.trim();
    if (v) window.localStorage.setItem(PENDING_STORE_KEY, v);
    else window.localStorage.removeItem(PENDING_STORE_KEY);
  } catch {
    // Storage blocked (private window, policy): the intake simply asks.
  }
}

export function LoginScreen({ variant = "signin" }: { variant?: "signin" | "signup" }) {
  const [email, setEmail] = useState("");
  const [store, setStore] = useState("");
  const [phase, setPhase] = useState<Phase>("form");
  const [error, setError] = useState<string | null>(
    typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("error") : null,
  );
  const [screenLink, setScreenLink] = useState<string | null>(null);

  const signup = variant === "signup";
  const sending = phase === "sending";

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (signup) rememberStore(store);
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
    <div className="desk au">
      {signup ? (
        <AuthMasthead href="/login">
          <span className="au-mast-pre">Already have an account? </span>Sign in <Arrow />
        </AuthMasthead>
      ) : (
        <AuthMasthead href="/signup">
          Create an account <Arrow />
        </AuthMasthead>
      )}

      <main className="au-main">
        <section className="au-lede">
          <p className="au-kicker">{signup ? "Open a new record" : "The record is waiting"}</p>
          <h1 className="au-headline">
            {signup ? "Start with the diagnosis." : "Back to your panel."}
          </h1>

          {signup ? (
            <div className="au-steps">
              <h2 className="au-steps-head" id="au-steps-head">
                What happens after this screen
              </h2>
              <table className="au-steps-table" aria-labelledby="au-steps-head">
                <tbody>
                  {SIGNUP_STEPS.map((s) => (
                    <tr key={s.n}>
                      <td className="au-n">{s.n}</td>
                      <td className="au-step">{s.text}</td>
                      <td className="au-takes">{s.takes}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <ol className="au-points">
              {SIGNIN_POINTS.map((p, i) => (
                <li key={p}>
                  <span className="au-n" aria-hidden="true">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <span>{p}</span>
                </li>
              ))}
            </ol>
          )}
        </section>

        <section className="sheet au-sheet" aria-labelledby="au-sheet-title">
          {phase === "sent" ? (
            <div aria-live="polite">
              <header className="au-sheet-head">
                <p className="au-sheet-label">Check your email</p>
                <h2 className="au-sheet-title" id="au-sheet-title">
                  {screenLink ? "Your link is below" : "Link sent"}
                </h2>
              </header>
              <div className="au-sheet-body">
                {screenLink ? (
                  <>
                    <p className="au-copy">
                      Email isn&rsquo;t configured here, so your one-time link is below. It expires
                      in {LINK_TTL_MINUTES}&nbsp;minutes.
                    </p>
                    <a className="au-primary" href={screenLink}>
                      <span>{signup ? "Create my account" : "Sign in now"}</span>
                      <Arrow />
                    </a>
                  </>
                ) : (
                  <p className="au-copy">
                    We sent a one-time link to <strong>{email}</strong>. It expires in{" "}
                    {LINK_TTL_MINUTES}&nbsp;minutes.
                  </p>
                )}
              </div>
              <footer className="au-sheet-foot">
                Wrong address?{" "}
                <button type="button" className="au-textbtn" onClick={() => setPhase("form")}>
                  Send another link
                </button>
              </footer>
            </div>
          ) : (
            <>
              <header className="au-sheet-head">
                <p className="au-sheet-label">{signup ? "Create account" : "Sign in"}</p>
                <h2 className="au-sheet-title" id="au-sheet-title">
                  {signup ? "Open your business’s record" : "Welcome back"}
                </h2>
              </header>

              <div className="au-sheet-body">
                <form onSubmit={(e) => void submit(e)} className="au-form">
                  <div className="au-field">
                    <label className="au-label" htmlFor="au-email">
                      Work email
                    </label>
                    <input
                      id="au-email"
                      className="au-input"
                      type="email"
                      required
                      autoFocus
                      autoComplete="email"
                      placeholder="you@yourbusiness.com"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      disabled={sending}
                    />
                  </div>

                  {signup && (
                    <div className="au-field">
                      <label className="au-label" htmlFor="au-store">
                        Website <span className="au-opt">(optional)</span>
                      </label>
                      <input
                        id="au-store"
                        className="au-input"
                        type="text"
                        inputMode="url"
                        autoComplete="url"
                        autoCapitalize="none"
                        spellCheck={false}
                        placeholder="yourbusiness.com"
                        value={store}
                        onChange={(e) => setStore(e.target.value)}
                        disabled={sending}
                      />
                    </div>
                  )}

                  <button className="au-primary" type="submit" disabled={sending}>
                    <span>
                      {sending ? "Sending…" : signup ? "Create account" : "Email me a sign-in link"}
                    </span>
                    <Arrow />
                  </button>
                </form>

                {error && (
                  <p className="au-error" role="alert">
                    {error}
                  </p>
                )}

                {/* The answer to "forgot password?", where the eye expects it. */}
                <p className="au-note">
                  {signup ? (
                    "No password, no card yet. You pay only when you order the report."
                  ) : (
                    <>No password. The link works once, for {LINK_TTL_MINUTES}&nbsp;minutes.</>
                  )}
                </p>

                <p className="au-or">
                  <span>{signup ? "Or sign up with" : "Or continue with"}</span>
                </p>

                <div className="au-sso">
                  {SSO_PROVIDERS.map((p) => (
                    <button key={p.id} type="button" className="au-door" onClick={() => sso(p.id)}>
                      <span>{p.label}</span>
                      <Arrow />
                    </button>
                  ))}
                </div>
              </div>

              <footer className="au-sheet-foot">
                {signup ? (
                  <>
                    By creating an account you agree to the <Link href="/terms">terms</Link> and{" "}
                    <Link href="/privacy">privacy notice</Link>.
                  </>
                ) : (
                  <>New to Ledgerline? Create an account from the top right.</>
                )}
              </footer>
            </>
          )}
        </section>
      </main>
    </div>
  );
}
