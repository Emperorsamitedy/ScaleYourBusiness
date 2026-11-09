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
// The desk carries the headline; one paper sheet carries the form both
// entrances share. Decluttered 2026-11-09 on the owner's instruction: no
// kicker, no promise list and no steps (the landing page says them), and
// the no-password note sits under "How this works". The SSO doors are real OAuth starts — a provider
// whose keys aren't set says so and points at the email path. They are
// named in words; the brands' logos would be the only icons on the
// screen.
//
// L-1 (TASKS-LANGUAGES.md): every word comes from the catalogue (auth.*);
// the brands' names and the figures are never translated.

import { useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { authErrorWords } from "../../lib/auth/error-words";
import { returnPath } from "../../lib/auth/return-to";
import { BROWSER_PREFILL } from "../../lib/intake/browser-prefill";
import { useTr } from "../sheet/useTr";
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

function Arrow() {
  return (
    <span className="au-arrow" aria-hidden="true">
      &rarr;
    </span>
  );
}

/** Idea 53: the card a sign-in should come back to, from ?next=. The server checks it again. */
function nextPath(): string | null {
  if (typeof window === "undefined") return null;
  return returnPath(new URLSearchParams(window.location.search).get("next"));
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

export function LoginScreen({
  variant = "signin",
  providers = [],
}: {
  variant?: "signin" | "signup";
  /** Providers whose keys exist (lib/auth/oauth configuredProviders); a button that can only fail isn't shown. */
  providers?: readonly string[];
}) {
  const doors = SSO_PROVIDERS.filter((p) => providers.includes(p.id));
  const t = useTranslations("auth");
  const tc = useTranslations("common");
  // L-4a: the server's English refusal, read back in the reader's language.
  const { tr: ta, locale } = useTr("authWords");
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
        // Idea 53: ?next=/proposals/<id> brings the owner back to that card (the server allowlists it).
        body: JSON.stringify({ email, ...(nextPath() ? { next: nextPath() } : {}) }),
      });
      const payload = (await res.json()) as {
        error?: string;
        delivered_via?: string;
        link?: string;
      };
      if (!res.ok) {
        setError(payload.error ?? tc("somethingWrong"));
        setPhase("form");
        return;
      }
      setScreenLink(payload.link ?? null);
      setPhase("sent");
    } catch {
      setError(tc("unreachable"));
      setPhase("form");
    }
  };

  const sso = (provider: string) => {
    const next = nextPath();
    window.location.href = `/api/auth/oauth/${provider}/start?from=${variant}${next ? `&next=${encodeURIComponent(next)}` : ""}`;
  };

  return (
    <div className="desk au">
      {signup ? (
        <AuthMasthead href="/login">
          {t("mast.signIn")} <Arrow />
        </AuthMasthead>
      ) : (
        <AuthMasthead href="/signup">
          {t("mast.createAccount")} <Arrow />
        </AuthMasthead>
      )}

      <main className="au-main">
        <section className="au-lede">
          <h1 className="au-headline">{signup ? t("signup.headline") : t("signin.headline")}</h1>
        </section>

        <section className="sheet au-sheet" aria-labelledby="au-sheet-title">
          {phase === "sent" ? (
            <div aria-live="polite">
              <header className="au-sheet-head">
                <h2 className="au-sheet-title" id="au-sheet-title">
                  {screenLink ? t("sent.titleBelow") : t("sent.titleSent")}
                </h2>
              </header>
              <div className="au-sheet-body">
                {screenLink ? (
                  <>
                    <p className="au-copy">{t("sent.onScreen", { minutes: LINK_TTL_MINUTES })}</p>
                    <a className="au-primary" href={screenLink}>
                      <span>{signup ? t("sent.createMine") : t("sent.signInNow")}</span>
                      <Arrow />
                    </a>
                  </>
                ) : (
                  <p className="au-copy">
                    {t.rich("sent.sentTo", {
                      email,
                      minutes: LINK_TTL_MINUTES,
                      b: (chunks) => <strong>{chunks}</strong>,
                    })}
                  </p>
                )}
              </div>
              <footer className="au-sheet-foot">
                {t("sent.wrongAddress")}{" "}
                <button type="button" className="au-textbtn" onClick={() => setPhase("form")}>
                  {t("sent.sendAnother")}
                </button>
              </footer>
            </div>
          ) : (
            <>
              <header className="au-sheet-head">
                <h2 className="au-sheet-title" id="au-sheet-title">
                  {signup ? t("form.labelCreate") : t("form.labelSignIn")}
                </h2>
              </header>

              <div className="au-sheet-body">
                <form onSubmit={(e) => void submit(e)} className="au-form">
                  <div className="au-field">
                    <label className="au-label" htmlFor="au-email">
                      {t("form.email")}
                    </label>
                    <input
                      id="au-email"
                      className="au-input"
                      type="email"
                      required
                      autoFocus
                      autoComplete="email"
                      placeholder={t("form.emailPlaceholder")}
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      disabled={sending}
                    />
                  </div>

                  {signup && (
                    <div className="au-field">
                      <label className="au-label" htmlFor="au-store">
                        {t("form.website")} <span className="au-opt">{t("form.optional")}</span>
                      </label>
                      <input
                        id="au-store"
                        className="au-input"
                        type="text"
                        inputMode="url"
                        autoComplete="url"
                        autoCapitalize="none"
                        spellCheck={false}
                        placeholder={t("form.websitePlaceholder")}
                        value={store}
                        onChange={(e) => setStore(e.target.value)}
                        disabled={sending}
                      />
                    </div>
                  )}

                  <button className="au-primary" type="submit" disabled={sending}>
                    <span>
                      {sending
                        ? t("form.sending")
                        : signup
                          ? t("form.submitCreate")
                          : t("form.submitSignIn")}
                    </span>
                    <Arrow />
                  </button>
                </form>

                {error && (
                  <p className="au-error" role="alert">
                    {authErrorWords(error, ta, locale)}
                  </p>
                )}

                {/* The answer to "forgot password?", one click away. */}
                <details className="au-how">
                  <summary>{t("how")}</summary>
                  <p>
                    {signup
                      ? t("form.noteSignup")
                      : t("form.noteSignin", { minutes: LINK_TTL_MINUTES })}
                  </p>
                </details>

                {doors.length > 0 && (
                  <>
                    <p className="au-or">
                      <span>{signup ? t("form.orSignup") : t("form.orSignin")}</span>
                    </p>

                    <div className="au-sso">
                      {doors.map((p) => (
                        <button
                          key={p.id}
                          type="button"
                          className="au-door"
                          onClick={() => sso(p.id)}
                        >
                          <span>{p.label}</span>
                          <Arrow />
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>

              {signup && (
                <footer className="au-sheet-foot">
                  {t.rich("form.terms", {
                    terms: (chunks) => <Link href="/terms">{chunks}</Link>,
                    privacy: (chunks) => <Link href="/privacy">{chunks}</Link>,
                  })}
                </footer>
              )}
            </>
          )}
        </section>
      </main>
    </div>
  );
}
