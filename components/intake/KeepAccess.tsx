"use client";

// P1-56: a way back in for a visitor with no account. No password — an email
// and a link that reopens the profile on any device. The link is shown on
// screen rather than promised by email, because a promised email that never
// arrives is worse than no promise. Used by the closing card and by the
// masthead's "Finish later".
//
// Since 2026-11-20 it is shown only to someone who is NOT signed in (the
// owner, looking at the closing card: "remove the get my link thing from
// here if unnecessary ... or put in a different way ... that adheres to
// accessibility and usability"). A signed-in owner's business is in their
// account, so for them it asked for an address to no purpose; they get the
// way onward instead (components/intake/IntakeStage.tsx). For the visitor it
// still serves, the field has a label a reader can see (it was a placeholder
// alone), what the link is for is said beside it, a refusal is announced and
// tied to the field, and the link, once made, can be copied with one press.

import { useId, useState } from "react";
import { useTranslations } from "next-intl";

export function KeepAccess() {
  const [email, setEmail] = useState("");
  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const id = useId();
  const t = useTranslations("intake.keep");
  const tErr = useTranslations("intake.error");

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
        // The server's sentences are English; the screen says it in the person's language.
        setError(res.status === 422 ? t("badEmail") : t("failed"));
        return;
      }
      setLink(payload.url ?? null);
    } catch {
      setError(tErr("unreachable"));
    } finally {
      setBusy(false);
    }
  };

  const copy = async (): Promise<void> => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      // No clipboard here (an old browser, a blocked permission): the link is
      // on the screen to be selected by hand, as it always was.
      setCopied(false);
    }
  };

  if (link) {
    return (
      <div className="ix-linkbox inset">
        <p className="ix-linkbox-note">
          <b>{t("linkCap")}</b> {t("linkNote", { days: 30 })}
        </p>
        <div className="ix-linkbox-row">
          <code>{link}</code>
          <button type="button" className="act" onClick={() => void copy()}>
            {copied ? t("copied") : t("copy")}
          </button>
        </div>
        {/* Said once to a screen reader; the button's own words change for the eye. */}
        <p className="sr-only" role="status">
          {copied ? t("copied") : ""}
        </p>
      </div>
    );
  }

  return (
    <form className="ix-keep" onSubmit={(e) => void submit(e)} noValidate>
      <label className="ix-keep-label" htmlFor={`${id}-email`}>
        {t("label")}
      </label>
      <div className="ix-finish">
        <input
          id={`${id}-email`}
          className="ix-input"
          type="email"
          inputMode="email"
          autoComplete="email"
          autoCapitalize="none"
          spellCheck={false}
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            setError(null);
          }}
          placeholder={t("placeholder")}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-err` : undefined}
        />
        <button type="submit" className="act solid" disabled={busy || email.trim() === ""}>
          {busy ? t("making") : t("get")}
        </button>
      </div>
      {error && (
        <p className="ix-err" id={`${id}-err`} role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
