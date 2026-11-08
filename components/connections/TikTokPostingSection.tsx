"use client";

// TikTok posting on /connections — 2026-11-08, rule 13.
//
// Its own card under write access: what SYB may post (the registry's
// consent lines, verbatim), that TikTok's API can't delete a post, what
// TikTok allows until it has audited SYB's app (everything private, "only
// me"), a typed phrase before sending the owner to TikTok, and revoke in one
// confirmed click. The consent lines and the phrase stay the registry's
// English, as on the Google card: the consent's hash covers them.

import { useEffect, useState } from "react";
import { bold, useCn, useSaid } from "./useCn";
import { storedDay } from "./words";

export interface TikTokPostingView {
  label: string;
  configured: boolean;
  audited: boolean;
  consent: string[];
  scope: string;
  readback_scopes: string[];
  confirm_phrase: string;
  connection: {
    id: string;
    status: "connected" | "paused" | "failed" | "disconnected";
    last_error: string | null;
    created_at: string;
  } | null;
  account: { nickname: string | null; username: string | null } | null;
}

const REASONS = new Set([
  "start_here",
  "signed_out",
  "owner_only",
  "unavailable",
  "phrase",
  "already_connected",
  "start_again",
  "foreign",
  "tiktok_error",
  "scope",
  "tiktok_refused",
  "internal",
]);

/** What TikTok's redirect back to /connections says, read once from the URL. */
function readReturn(): { kind: string; reason: string | null } | null {
  const q = new URLSearchParams(window.location.search);
  const kind = q.get("tiktok");
  if (kind !== "connected" && kind !== "cancelled" && kind !== "error") return null;
  return { kind, reason: q.get("reason") };
}

function clearReturn(): void {
  const url = new URL(window.location.href);
  for (const key of ["tiktok", "reason"]) url.searchParams.delete(key);
  window.history.replaceState(null, "", url.pathname + url.search + url.hash);
}

export function TikTokPostingSection({
  view,
  onChanged,
}: {
  view: TikTokPostingView;
  onChanged: () => Promise<void>;
}) {
  const { t, locale } = useCn("connections.tiktok");
  const said = useSaid();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [leaving, setLeaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const back = readReturn();
    if (back === null) return;
    clearReturn();
    if (back.kind === "connected") setNotice(t("connected"));
    else if (back.kind === "cancelled") setNotice(t("youCancelled"));
    // A code from the closed set, never text from the URL.
    else
      setError(
        t(back.reason && REASONS.has(back.reason) ? `reason.${back.reason}` : "reason.generic"),
      );
  }, []);

  const c = view.connection;
  const status = (s: string) => (t.has(`status.${s}`) ? t(`status.${s}`) : s);
  const confirmed = typed.trim().toLowerCase() === view.confirm_phrase;
  const who =
    view.account?.nickname ?? (view.account?.username ? `@${view.account.username}` : null);

  const revoke = async () => {
    if (!c) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/connections/tiktok-posting", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: c.id }),
      });
      const payload = (await res.json().catch(() => null)) as {
        error?: unknown;
        revoked_on_tiktok?: unknown;
      } | null;
      if (!res.ok) {
        setError(typeof payload?.error === "string" ? said(payload.error) : t("revokeFailed"));
        return;
      }
      setConfirmRevoke(false);
      setNotice(payload?.revoked_on_tiktok === true ? t("revoked") : t("revokedHereOnly"));
      await onChanged();
    } catch {
      setError(t("unreachable"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="cn-write cn-email-wrap" aria-label={t("label")}>
      <section className="cs cn-write-card cn-email" aria-labelledby="cn-tiktok-title">
        <header className="cs-head">
          <div>
            <p className="cs-label">{t("sectionLabel")}</p>
            <h2 className="cs-title" id="cn-tiktok-title">
              {c ? t("title.on") : t("title.off")}
            </h2>
          </div>
        </header>
        <div className="cs-body cn-write-body">
          <div className="cn-wp">
            <div className="cn-wp-head">
              <div>
                <h3 className="cn-wp-name">{locale === "en" ? view.label : t("label")}</h3>
                <p className="cn-wp-state">
                  {c
                    ? t("consentedOn", {
                        day: storedDay(c.created_at, locale),
                        status: status(c.status),
                      })
                    : view.configured
                      ? t("notGranted")
                      : t("notSetUpYet")}
                </p>
              </div>
              {c === null && view.configured && (
                <button
                  type="button"
                  className="prop-btn"
                  aria-expanded={open}
                  aria-controls="cn-grant-tiktok"
                  onClick={() => setOpen(!open)}
                >
                  {open ? t("close") : t("connect")}
                </button>
              )}
              {c === null && !view.configured && (
                <button type="button" className="ghost" disabled>
                  {t("connect")}
                </button>
              )}
            </div>
            {/* Access honesty: what TikTok allows until its audit of SYB's app passes. */}
            <p className="cn-note">{view.audited ? t("access.audited") : t("access.unaudited")}</p>
            <ul className="cn-consent">
              {view.consent.map((line) => (
                <li key={line}>
                  <span className="cn-consent-why">{line}</span>
                  <span className="cn-scope">{view.scope}</span>
                </li>
              ))}
            </ul>
            <p className="cn-note">
              {t("readback")} <span className="cn-scope">{view.readback_scopes.join(" · ")}</span>
            </p>
            {c === null && !view.configured && <p className="cn-note">{t("notSetUp")}</p>}
            {c === null && (
              <div className="cn-wp-detail">
                <p className="cn-sub">{t("before")}</p>
                <ul className="cn-list">
                  <li>{t("needs.app")}</li>
                  <li>{t("needs.signIn")}</li>
                  <li>{t("needs.choose")}</li>
                </ul>
              </div>
            )}
            {c !== null && (
              <div className="cn-wp-detail">
                <dl className="cn-facts">
                  <dt>{t("fact.status")}</dt>
                  <dd>
                    <span className={`word ${c.status === "connected" ? "ok" : "alarm"}`}>
                      {status(c.status)}
                    </span>
                  </dd>
                  {who && (
                    <>
                      <dt>{t("fact.account")}</dt>
                      <dd>{who}</dd>
                    </>
                  )}
                  <dt>{t("fact.whoSees")}</dt>
                  <dd>{view.audited ? t("fact.chosen") : t("fact.private")}</dd>
                </dl>
                {c.last_error && <p className="cn-error">{said(c.last_error)}</p>}
                <div className="cn-acts">
                  {confirmRevoke ? (
                    <>
                      <span className="cn-note">{t("revokeAsk")}</span>
                      <button
                        type="button"
                        className="ghost"
                        disabled={busy}
                        onClick={() => void revoke()}
                      >
                        {busy ? t("revoking") : t("yesRevoke")}
                      </button>
                      <button
                        type="button"
                        className="ghost"
                        onClick={() => setConfirmRevoke(false)}
                      >
                        {t("keepIt")}
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="ghost"
                      disabled={busy}
                      onClick={() => setConfirmRevoke(true)}
                    >
                      {t("revoke")}
                    </button>
                  )}
                </div>
                <p className="cn-note">{t("revokeNote")}</p>
              </div>
            )}
            {c === null && view.configured && open && (
              <div className="cn-wp-detail" id="cn-grant-tiktok">
                <p className="cn-note">{t("tiktokScreen")}</p>
                <form
                  className="cn-form"
                  method="post"
                  action="/api/connections/tiktok-posting/start"
                  onSubmit={() => setLeaving(true)}
                >
                  <label className="cn-field">
                    <span className="cn-field-label">
                      {t.rich("typeToConfirm", { ...bold, phrase: view.confirm_phrase })}
                    </span>
                    <input
                      className="cn-input"
                      type="text"
                      name="confirmation"
                      autoComplete="off"
                      spellCheck={false}
                      value={typed}
                      onChange={(e) => setTyped(e.target.value)}
                      disabled={leaving}
                    />
                  </label>
                  <button className="next" type="submit" disabled={leaving || !confirmed}>
                    {leaving ? t("opening") : t("signIn")}
                  </button>
                </form>
              </div>
            )}
            {error !== null && (
              <p className="cn-error" role="alert">
                {error}
              </p>
            )}
            {notice !== null && (
              <p className="cn-notice" aria-live="polite">
                {notice}
              </p>
            )}
          </div>
        </div>
        <footer className="cs-foot">{t("nothingWritten")}</footer>
      </section>
    </div>
  );
}
