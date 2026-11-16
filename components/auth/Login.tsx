"use client";

// The sign-in / sign-up screens — P1-49, redesigned 2026-11-16 on the
// owner's approved mockup (the "ScaleX sign-in redesign" canvas).
//
// There are no passwords here, so there is no "forgot password": the
// emailed one-shot link is the key, every time. Sign-up and sign-in are the
// same motion (the link creates the account the first time an email proves
// itself), but they are two ENTRANCES with two layouts:
//
//   /login   one centred card on the Ink ground, for people coming back.
//   /signup  a split screen: the form on paper at left, and at right a
//            looping tour of real ScaleX screens over the holographic image.
//
// After the link is sent, the same card turns into "check your email": the
// address it went to, the webmail button when the domain is a known one,
// a resend with a cool-down, and a way back to change the address.
//
// Language is a footer switcher, not a step: the intake still asks for the
// language and currency before its first question when they haven't been
// chosen (L-1, TASKS-LANGUAGES.md, amended 2026-11-16).
//
// L-1: every word comes from the catalogue (auth.*); brand names and
// figures are never translated.

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { authErrorWords } from "../../lib/auth/error-words";
import { mailAppFor } from "../../lib/auth/mail-app";
import { returnPath } from "../../lib/auth/return-to";
import type { LanguageOption } from "../../lib/i18n/picker";
import { Logo } from "../brand/Mark";
import { useTr } from "../sheet/useTr";
import { AuthReel } from "./AuthReel";
import "../../app/auth-v2.css";

type Phase = "form" | "sending" | "sent";

// Mirrors LOGIN_TTL_MINUTES in lib/auth/service.ts. That module pulls in
// the database and node:crypto, so it cannot be imported into a client
// component; change both together.
const LINK_TTL_MINUTES = 15;
const RESEND_SECONDS = 45;
/** Which door this browser came in by last time: "email" or a provider id. */
const LAST_USED_KEY = "scalex.lastSignIn";

const SSO_PROVIDERS = [
  { id: "google", label: "Google" },
  { id: "apple", label: "Apple" },
  { id: "microsoft", label: "Microsoft" },
] as const;

function GoogleG() {
  return (
    <svg width="20" height="20" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}

function MailIcon() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="5" width="18" height="14" rx="2.5" />
      <path d="M3.5 6.5l8.5 6 8.5-6" />
    </svg>
  );
}

/** Idea 53: the card a sign-in should come back to, from ?next=. The server checks it again. */
function nextPath(): string | null {
  if (typeof window === "undefined") return null;
  return returnPath(new URLSearchParams(window.location.search).get("next"));
}

function readLastUsed(): string | null {
  try {
    return window.localStorage.getItem(LAST_USED_KEY);
  } catch {
    return null;
  }
}

function rememberLastUsed(door: string) {
  try {
    window.localStorage.setItem(LAST_USED_KEY, door);
  } catch {
    // Storage blocked (private window, policy): the badge simply doesn't show.
  }
}

/** The footer: a language switcher that saves through /api/locale, then the legal links. */
function AuthFooter({
  languages,
  language,
}: {
  languages: readonly LanguageOption[];
  language?: string | undefined;
}) {
  const t = useTranslations("auth.foot");
  const router = useRouter();
  const change = async (code: string) => {
    try {
      const res = await fetch("/api/locale", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ language: code }),
      });
      if (res.ok) router.refresh();
    } catch {
      // Unreachable: the page stays in its current language.
    }
  };
  return (
    <footer className="ax-foot">
      {languages.length > 1 && (
        <label className="ax-lang">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
            <circle cx="12" cy="12" r="9" />
            <path d="M3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3z" />
          </svg>
          <span className="ax-sr">{t("language")}</span>
          <select value={language} onChange={(e) => void change(e.target.value)}>
            {languages.map((l) => (
              <option key={l.code} value={l.code}>
                {l.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <Link href="/terms">{t("terms")}</Link>
      <Link href="/privacy">{t("privacy")}</Link>
    </footer>
  );
}

export function LoginScreen({
  variant = "signin",
  providers = [],
  languages = [],
  language,
}: {
  variant?: "signin" | "signup";
  /** Providers whose keys exist (lib/auth/oauth configuredProviders); a button that can only fail isn't shown. */
  providers?: readonly string[];
  /** The languages this visitor may switch to (lib/i18n/server pickerContext). */
  languages?: readonly LanguageOption[];
  language?: string;
}) {
  const doors = SSO_PROVIDERS.filter((p) => providers.includes(p.id));
  const t = useTranslations("auth");
  const tc = useTranslations("common");
  // L-4a: the server's English refusal, read back in the reader's language.
  const { tr: ta, locale } = useTr("authWords");
  const [email, setEmail] = useState("");
  const [phase, setPhase] = useState<Phase>("form");
  const [error, setError] = useState<string | null>(
    typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("error") : null,
  );
  const [screenLink, setScreenLink] = useState<string | null>(null);
  const [lastUsed, setLastUsed] = useState<string | null>(null);
  const [wait, setWait] = useState(0);
  const [resent, setResent] = useState(false);
  const [code, setCode] = useState("");
  const [checking, setChecking] = useState(false);

  const signup = variant === "signup";
  const sending = phase === "sending";

  useEffect(() => setLastUsed(readLastUsed()), []);
  useEffect(() => {
    if (wait <= 0) return;
    const id = window.setTimeout(() => setWait((w) => w - 1), 1000);
    return () => window.clearTimeout(id);
  }, [wait]);

  const send = async (): Promise<boolean> => {
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        // Idea 53: ?next=/proposals/<id> brings the owner back to that card (the server allowlists it).
        body: JSON.stringify({ email, ...(nextPath() ? { next: nextPath() } : {}) }),
      });
      const payload = (await res.json()) as { error?: string; link?: string };
      if (!res.ok) {
        setError(payload.error ?? tc("somethingWrong"));
        return false;
      }
      setScreenLink(payload.link ?? null);
      return true;
    } catch {
      setError(tc("unreachable"));
      return false;
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setPhase("sending");
    const ok = await send();
    if (ok) {
      rememberLastUsed("email");
      setResent(false);
      setWait(RESEND_SECONDS);
    }
    setPhase(ok ? "sent" : "form");
  };

  const resend = async () => {
    if (wait > 0) return;
    const ok = await send();
    if (ok) {
      setResent(true);
      setWait(RESEND_SECONDS);
    }
  };

  // The 6-digit code from the same email: signs in on THIS device, for an
  // owner reading their email somewhere else (POST /api/auth/redeem-code).
  const redeemCode = async (e: React.FormEvent) => {
    e.preventDefault();
    setChecking(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/redeem-code", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, code }),
      });
      const payload = (await res.json()) as { error?: string; landing?: string };
      if (res.ok && payload.landing) {
        window.location.href = payload.landing;
        return;
      }
      setError(payload.error ?? tc("somethingWrong"));
    } catch {
      setError(tc("unreachable"));
    }
    setChecking(false);
  };

  const sso = (provider: string) => {
    rememberLastUsed(provider);
    const next = nextPath();
    window.location.href = `/api/auth/oauth/${provider}/start?from=${variant}${next ? `&next=${encodeURIComponent(next)}` : ""}`;
  };

  const errorLine = error ? (
    <p className="ax-error" role="alert">
      {authErrorWords(error, ta, locale)}
    </p>
  ) : null;

  const ssoButtons = doors.map((p) => (
    <button key={p.id} type="button" className="ax-btn ax-door" onClick={() => sso(p.id)}>
      {p.id === "google" ? <GoogleG /> : null}
      <span>{t("form.continueWith", { provider: p.label })}</span>
      {!signup && lastUsed === p.id ? <span className="ax-badge">{t("form.lastUsed")}</span> : null}
    </button>
  ));

  const emailField = (
    <div className="ax-field">
      <label className="ax-label" htmlFor="ax-email">
        {t("form.email")}
      </label>
      <input
        id="ax-email"
        className="ax-input"
        type="email"
        required
        autoFocus
        autoComplete={signup ? "email" : "username"}
        placeholder={t("form.emailPlaceholder")}
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        disabled={sending}
      />
    </div>
  );

  const submitButton = (
    <button className="ax-btn ax-primary" type="submit" disabled={sending}>
      <span>
        {sending ? t("form.sending") : signup ? t("form.submitCreate") : t("form.submitSignIn")}
      </span>
      {!signup && lastUsed === "email" && doors.length > 0 ? (
        <span className="ax-badge ax-badge-dark">{t("form.lastUsed")}</span>
      ) : null}
    </button>
  );

  const mailApp = mailAppFor(email);
  const sent = (
    <div className="ax-sent" aria-live="polite">
      <span className="ax-sent-icon">
        <MailIcon />
      </span>
      {screenLink ? (
        <>
          <h1 className="ax-title">{t("sent.titleBelow")}</h1>
          <p className="ax-copy">{t("sent.onScreen", { minutes: LINK_TTL_MINUTES })}</p>
          <a className="ax-btn ax-primary" href={screenLink}>
            <span>{signup ? t("sent.createMine") : t("sent.signInNow")}</span>
          </a>
        </>
      ) : (
        <>
          <h1 className="ax-title">{t("sent.checkEmail")}</h1>
          <p className="ax-copy">
            {t.rich("sent.sentTo", {
              email,
              minutes: LINK_TTL_MINUTES,
              b: (chunks) => <strong>{chunks}</strong>,
            })}
          </p>
          {mailApp && (
            <a className="ax-btn ax-door" href={mailApp.url} target="_blank" rel="noreferrer">
              <span>{mailApp.name === "Gmail" ? t("sent.openGmail") : t("sent.openOutlook")}</span>
            </a>
          )}
        </>
      )}
      <form className="ax-field" onSubmit={(e) => void redeemCode(e)}>
        <label className="ax-label" htmlFor="ax-code">
          {t("sent.codeLabel")}
        </label>
        <div className="ax-code-row">
          <input
            id="ax-code"
            className="ax-input ax-code"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="123 456"
            maxLength={9}
            required
            value={code}
            onChange={(e) => setCode(e.target.value)}
            disabled={checking}
          />
          <button className="ax-btn ax-primary" type="submit" disabled={checking}>
            <span>{checking ? t("sent.codeChecking") : t("sent.codeSubmit")}</span>
          </button>
        </div>
      </form>
      {errorLine}
      <div className="ax-sent-foot">
        {!screenLink && (
          <p>
            {t("sent.nothingYet")}{" "}
            {resent && wait > 0 ? (
              <span className="ax-muted">{t("sent.resent")}</span>
            ) : (
              <button type="button" className="ax-textbtn" onClick={() => void resend()} disabled={wait > 0}>
                {wait > 0 ? t("sent.resendIn", { seconds: wait }) : t("sent.resend")}
              </button>
            )}
          </p>
        )}
        <button
          type="button"
          className="ax-textbtn"
          onClick={() => {
            setPhase("form");
            setError(null);
          }}
        >
          {t("sent.differentEmail")}
        </button>
      </div>
    </div>
  );

  if (!signup) {
    return (
      <div className="ax ax-signin">
        <Link href="/" className="ax-logo">
          <Logo onDark />
        </Link>
        <main className="ax-card">
          {phase === "sent" ? (
            sent
          ) : (
            <>
              <div className="ax-head">
                <h1 className="ax-title">{t("signin.headline")}</h1>
                <p className="ax-sub">{t("signin.sub")}</p>
              </div>
              <form onSubmit={(e) => void submit(e)} className="ax-form">
                {emailField}
                {submitButton}
              </form>
              {errorLine}
              {doors.length > 0 && (
                <>
                  <p className="ax-or">
                    <span>{t("form.or")}</span>
                  </p>
                  <div className="ax-doors">{ssoButtons}</div>
                </>
              )}
              <p className="ax-note">{t("form.noteSignin", { minutes: LINK_TTL_MINUTES })}</p>
            </>
          )}
        </main>
        <p className="ax-switch">
          {t("switch.newHere")} <Link href="/signup">{t("mast.createAccount")}</Link>
        </p>
        <AuthFooter languages={languages} language={language} />
      </div>
    );
  }

  return (
    <div className="ax ax-signup">
      <section className="ax-col">
        <div className="ax-col-in">
          <Link href="/" className="ax-logo">
            <Logo />
          </Link>
          <main className="ax-signup-main">
            {phase === "sent" ? (
              sent
            ) : (
              <>
                <h1 className="ax-title ax-title-lg">{t("signup.headline")}</h1>
                {doors.length > 0 && (
                  <>
                    <div className="ax-doors">{ssoButtons}</div>
                    <p className="ax-or">
                      <span>{t("form.orEmail")}</span>
                    </p>
                  </>
                )}
                <form onSubmit={(e) => void submit(e)} className="ax-form">
                  {emailField}
                  {submitButton}
                </form>
                {errorLine}
                <p className="ax-note">
                  {t.rich("form.terms", {
                    terms: (chunks) => <Link href="/terms">{chunks}</Link>,
                    privacy: (chunks) => <Link href="/privacy">{chunks}</Link>,
                  })}
                </p>
                <p className="ax-switch-light">
                  {t("switch.haveAccount")} <Link href="/login">{t("mast.signIn")}</Link>
                </p>
              </>
            )}
          </main>
          <AuthFooter languages={languages} language={language} />
        </div>
      </section>
      <AuthReel />
    </div>
  );
}
