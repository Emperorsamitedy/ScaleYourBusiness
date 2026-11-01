"use client";

// P1-56: a way back in. No password — an email and a link that reopens
// the profile on any device. The link is shown on screen rather than
// promised by email, because a promised email that never arrives is worse
// than no promise. Used by the done card and by the masthead's
// "Pause — finish later".

import { useState } from "react";
import { useTranslations } from "next-intl";

export function KeepAccess() {
  const [email, setEmail] = useState("");
  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
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

  if (link) {
    return (
      <div className="ix-linkbox inset">
        <span className="ix-cap">{t("linkCap")}</span> {t("linkNote", { days: 30 })}
        <code>{link}</code>
      </div>
    );
  }

  return (
    <form className="ix-finish" onSubmit={(e) => void submit(e)}>
      <input
        className="ix-input"
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder={t("placeholder")}
        aria-label={t("label")}
      />
      <button type="submit" className="act solid" disabled={busy || email.trim() === ""}>
        {busy ? t("making") : <>{t("get")} &rarr;</>}
      </button>
      {error && <p className="ix-err">{error}</p>}
    </form>
  );
}
