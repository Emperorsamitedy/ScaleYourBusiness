"use client";

// TikTok Ads on /connections — TikTok Ads (2026-11-08), rule 13.
//
// Its own section under write access, because TikTok can't separate
// reading campaigns from changing them: an advertiser grants an app its
// whole permission list, so SYB holds both as one consent. The card says
// that plainly, renders the registry's consent lines verbatim, asks for a
// typed phrase before sending the owner to TikTok, names exactly which of
// SYB's settings are missing when the app isn't set up, says what TikTok's
// app check means for access, and revokes in one confirmed click.
//
// The section's words are the "connections.tiktok" catalogue. The consent
// lines and the phrase stay the registry's English: the consent's hash
// covers them.

import { useEffect, useState } from "react";
import { isTikTokReason } from "../../lib/tiktok/reasons";
import { bold, useCn, useSaid } from "./useCn";
import { storedDay } from "./words";

export interface TikTokView {
  label: string;
  configured: boolean;
  missing: string[];
  consent: string[];
  scopes: string[];
  confirm_phrase: string;
  connection: {
    id: string;
    status: "connected" | "paused" | "failed" | "disconnected";
    granted_scopes: string[];
    last_error: string | null;
    created_at: string;
  } | null;
  advertisers: number | null;
  last_read: string | null;
}

/** TikTok's own names for the four permissions the app must tick — what its screen shows. */
const TIKTOK_PERMISSION_NAMES = [
  "Read Ad Account Information",
  "Read Campaigns",
  "Create and Update Campaigns",
  "Consolidated Report",
];

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

export function TikTokAdsSection({
  view,
  onChanged,
}: {
  view: TikTokView;
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
    // A code from the closed set, never text from the URL (lib/tiktok/reasons).
    else setError(t(isTikTokReason(back.reason) ? `reason.${back.reason}` : "reason.generic"));
  }, []);

  const c = view.connection;
  const status = (s: string) => (t.has(`status.${s}`) ? t(`status.${s}`) : s);
  const confirmed = typed.trim().toLowerCase() === view.confirm_phrase;
  const callback =
    typeof window === "undefined"
      ? "/api/connections/tiktok/callback"
      : `${window.location.origin}/api/connections/tiktok/callback`;

  const revoke = async () => {
    if (!c) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/connections/tiktok", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: c.id }),
      });
      const payload = (await res.json().catch(() => null)) as { error?: unknown } | null;
      if (!res.ok) {
        setError(typeof payload?.error === "string" ? said(payload.error) : t("revokeFailed"));
        return;
      }
      setConfirmRevoke(false);
      setNotice(t("revoked"));
      await onChanged();
    } catch {
      setError(t("unreachable"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="cn-write cn-email-wrap" aria-label={view.label}>
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
              {c === null && (
                <button
                  type="button"
                  className={view.configured ? "prop-btn" : "ghost"}
                  disabled={!view.configured}
                  aria-expanded={open}
                  aria-controls="cn-grant-tiktok"
                  onClick={() => setOpen(!open)}
                >
                  {open ? t("close") : t("connect")}
                </button>
              )}
            </div>
            <p className="cn-note">{t("whyOne")}</p>
            <ul className="cn-consent">
              {view.consent.map((line) => (
                <li key={line}>
                  <span className="cn-consent-why">{line}</span>
                </li>
              ))}
            </ul>
            <div className="cn-wp-detail">
              <p className="cn-sub">{t("access.title")}</p>
              <ul className="cn-list">
                <li>{t("access.check")}</li>
                <li>{t("access.sandbox")}</li>
              </ul>
            </div>
            {c === null && !view.configured && (
              <div className="cn-wp-detail">
                <p className="cn-sub">{t("missing.title")}</p>
                <ul className="cn-list">
                  {view.missing.map((key) => (
                    <li key={key}>
                      <code>{key}</code>
                    </li>
                  ))}
                </ul>
                <p className="cn-sub">{t("steps.title")}</p>
                <ol className="cn-list">
                  <li>{t("steps.developer", { site: "business-api.tiktok.com" })}</li>
                  <li>{t("steps.app", { callback })}</li>
                  <li>{t("steps.scopes", { scopes: TIKTOK_PERMISSION_NAMES.join(", ") })}</li>
                  <li>{t("steps.submit")}</li>
                  <li>
                    {t("steps.keys", {
                      appId: "TIKTOK_ADS_APP_ID",
                      secret: "TIKTOK_ADS_SECRET",
                      redirect: "TIKTOK_ADS_REDIRECT_URI",
                    })}
                  </li>
                </ol>
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
                  {view.advertisers !== null && (
                    <>
                      <dt>{t("fact.adAccounts")}</dt>
                      <dd>{view.advertisers.toLocaleString(locale)}</dd>
                    </>
                  )}
                  <dt>{t("fact.lastRead")}</dt>
                  <dd>{view.last_read ? storedDay(view.last_read, locale) : t("fact.notYet")}</dd>
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
                  action="/api/connections/tiktok/start"
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
