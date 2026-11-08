"use client";

// Google Ads on /connections — P2-20 / P3-22, rule 13.
//
// Its own section under write access, because Google's only Google Ads
// permission can change campaigns, budgets and ads, even though SYB reads
// with it every day and changes anything only through a proposal the owner
// approves. The section says that plainly, renders the registry's consent
// lines verbatim, states Google's access level for SYB honestly (test
// accounts only until Google approves more), names exactly which keys are
// missing when it isn't set up, asks for a typed phrase before sending the
// owner to Google, lets them pick an ad account when they reach several,
// and revokes in one confirmed click.
//
// The words are the "connections.googleAds" catalogue, sharing the plain
// verbs with "connections.google". The consent lines and the phrase stay
// the registry's English: the consent's hash covers them.

import { useEffect, useState } from "react";
import { isGoogleAdsReason } from "../../lib/google-ads/reasons";
import { bold, useCn, useSaid } from "./useCn";
import { storedDay } from "./words";

export interface GoogleAdsView {
  label: string;
  configured: boolean;
  missing: string[];
  access_level: "test" | "explorer" | "basic" | "standard" | null;
  consent: string[];
  scope: string;
  confirm_phrase: string;
  connection: {
    id: string;
    status: "connected" | "paused" | "failed" | "disconnected";
    granted_scopes: string[];
    last_error: string | null;
    created_at: string;
  } | null;
  account: { name: string; customer_id: string; currency: string } | null;
  last_read: { at: string; error: string | null } | null;
  pick: { id: string; name: string; currency: string; manager: boolean }[] | null;
}

/** Google's published daily operation caps per access level (access-levels page, 2026-11-08). */
const DAILY_OPS: Readonly<Record<string, number>> = { explorer: 2880, basic: 15000 };

function readReturn(): { kind: string; reason: string | null } | null {
  const q = new URLSearchParams(window.location.search);
  const kind = q.get("gads");
  if (kind !== "connected" && kind !== "pick" && kind !== "cancelled" && kind !== "error") {
    return null;
  }
  return { kind, reason: q.get("reason") };
}

function clearReturn(): void {
  const url = new URL(window.location.href);
  for (const key of ["gads", "reason"]) url.searchParams.delete(key);
  window.history.replaceState(null, "", url.pathname + url.search + url.hash);
}

async function call(path: string, method: "POST" | "DELETE", body: unknown) {
  const res = await fetch(path, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await res.json().catch(() => null)) as { error?: unknown } | null;
  return { ok: res.ok, error: typeof payload?.error === "string" ? payload.error : null };
}

/** "1234567890" → "123-456-7890", the way Google Ads shows a customer id. */
const dashed = (id: string) => id.replace(/^(\d{3})(\d{3})(\d{4})$/, "$1-$2-$3");

export function GoogleAdsSection({
  view,
  onChanged,
}: {
  view: GoogleAdsView;
  onChanged: () => Promise<void>;
}) {
  const { t, locale } = useCn("connections.googleAds");
  const { t: tg } = useCn("connections.google");
  const said = useSaid();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [leaving, setLeaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState("");
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const back = readReturn();
    if (back === null) return;
    clearReturn();
    if (back.kind === "connected") setNotice(t("connected"));
    else if (back.kind === "pick") setNotice(t("signedInPick"));
    else if (back.kind === "cancelled") setNotice(tg("youCancelled"));
    // A code from the closed set, never text from the URL (lib/google-ads/reasons).
    else setError(t(isGoogleAdsReason(back.reason) ? `reason.${back.reason}` : "reason.generic"));
  }, []);

  const c = view.connection;
  const status = (s: string) => (tg.has(`status.${s}`) ? tg(`status.${s}`) : s);
  const confirmed = typed.trim().toLowerCase() === view.confirm_phrase;
  const level = view.access_level;
  const levelWords =
    level === null
      ? t("accessLevel.unknown")
      : t(`accessLevel.${level}`, { ops: (DAILY_OPS[level] ?? 0).toLocaleString(locale) });

  const finish = async () => {
    setBusy(true);
    setError(null);
    try {
      const out = await call("/api/connections/google-ads/finish", "POST", {
        customer_id: picked,
      });
      if (!out.ok) setError(out.error !== null ? said(out.error) : tg("connectFailed"));
      else setNotice(t("connected"));
      await onChanged();
    } catch {
      setError(tg("unreachable"));
    } finally {
      setBusy(false);
    }
  };

  const forgetPick = async () => {
    setBusy(true);
    try {
      await call("/api/connections/google-ads", "DELETE", { pending: true });
      setNotice(tg("nothingConnected"));
      await onChanged();
    } finally {
      setBusy(false);
    }
  };

  const revoke = async () => {
    if (!c) return;
    setBusy(true);
    setError(null);
    try {
      const out = await call("/api/connections/google-ads", "DELETE", { id: c.id });
      if (!out.ok) {
        setError(out.error !== null ? said(out.error) : tg("revokeFailed"));
        return;
      }
      setConfirmRevoke(false);
      setNotice(t("revoked"));
      await onChanged();
    } catch {
      setError(tg("unreachable"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="cn-write cn-email-wrap" aria-label={t("label")}>
      <section className="cs cn-write-card cn-email" aria-labelledby="cn-gads-title">
        <header className="cs-head">
          <div>
            <p className="cs-label">{t("sectionLabel")}</p>
            <h2 className="cs-title" id="cn-gads-title">
              {c ? t("title.on") : t("title.off")}
            </h2>
          </div>
        </header>
        <div className="cs-body cn-write-body">
          <div className="cn-wp">
            <div className="cn-wp-head">
              <div>
                <h3 className="cn-wp-name">{view.label}</h3>
                <p className="cn-wp-state">
                  {c
                    ? tg("consentedOn", {
                        day: storedDay(c.created_at, locale),
                        status: status(c.status),
                      })
                    : view.configured
                      ? tg("notGranted")
                      : tg("notSetUpYet")}
                </p>
              </div>
              {c === null && view.pick === null && view.configured && (
                <button
                  type="button"
                  className="prop-btn"
                  aria-expanded={open}
                  aria-controls="cn-grant-gads"
                  onClick={() => setOpen(!open)}
                >
                  {open ? tg("close") : tg("connect")}
                </button>
              )}
              {c === null && !view.configured && (
                <button type="button" className="ghost" disabled>
                  {tg("connect")}
                </button>
              )}
            </div>
            <p className="cn-note">{t("whatItCanDo")}</p>
            <ul className="cn-consent">
              {view.consent.map((line) => (
                <li key={line}>
                  <span className="cn-consent-why">{line}</span>
                  <span className="cn-scope">{view.scope}</span>
                </li>
              ))}
            </ul>
            <dl className="cn-facts">
              <dt>{t("accessLevel.title")}</dt>
              <dd>{levelWords}</dd>
            </dl>
            {!view.configured && view.missing.length > 0 && (
              <p className="cn-note">{t("notSetUp", { keys: view.missing.join(", ") })}</p>
            )}
            {c !== null && (
              <div className="cn-wp-detail">
                <dl className="cn-facts">
                  <dt>{tg("fact.status")}</dt>
                  <dd>
                    <span className={`word ${c.status === "connected" ? "ok" : "alarm"}`}>
                      {status(c.status)}
                    </span>
                  </dd>
                  {view.account && (
                    <>
                      <dt>{t("fact.account")}</dt>
                      <dd>
                        {view.account.name} · {dashed(view.account.customer_id)} ·{" "}
                        {view.account.currency}
                      </dd>
                    </>
                  )}
                  <dt>{tg("fact.lastRead")}</dt>
                  <dd>
                    {view.last_read ? storedDay(view.last_read.at, locale) : tg("fact.notYet")}
                  </dd>
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
                        {busy ? tg("revoking") : tg("yesRevoke")}
                      </button>
                      <button
                        type="button"
                        className="ghost"
                        onClick={() => setConfirmRevoke(false)}
                      >
                        {tg("keepIt")}
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="ghost"
                      disabled={busy}
                      onClick={() => setConfirmRevoke(true)}
                    >
                      {tg("revoke")}
                    </button>
                  )}
                </div>
                <p className="cn-note">{t("revokeNote")}</p>
              </div>
            )}
            {c === null && view.pick !== null && (
              <div className="cn-wp-detail">
                <p className="cn-sub">{t("pickTitle")}</p>
                <ul className="cn-list">
                  {view.pick.map((a) => (
                    <li key={a.id}>
                      <label>
                        <input
                          type="radio"
                          name="google-ads-account"
                          value={a.id}
                          checked={picked === a.id}
                          onChange={() => setPicked(a.id)}
                          disabled={busy || a.manager}
                        />{" "}
                        {a.name} · {dashed(a.id)} · {a.currency}
                        {a.manager ? ` (${t("managerNote")})` : ""}
                      </label>
                    </li>
                  ))}
                </ul>
                <div className="cn-acts">
                  <button
                    className="next"
                    type="button"
                    disabled={busy || picked === ""}
                    onClick={() => void finish()}
                  >
                    {busy ? tg("recording") : t("connectAccount")}
                  </button>
                  <button
                    type="button"
                    className="ghost"
                    disabled={busy}
                    onClick={() => void forgetPick()}
                  >
                    {tg("cancel")}
                  </button>
                </div>
              </div>
            )}
            {c === null && view.pick === null && view.configured && open && (
              <div className="cn-wp-detail" id="cn-grant-gads">
                <p className="cn-note">{tg("googleScreen")}</p>
                <form
                  className="cn-form"
                  method="post"
                  action="/api/connections/google-ads/start"
                  onSubmit={() => setLeaving(true)}
                >
                  <label className="cn-field">
                    <span className="cn-field-label">
                      {tg.rich("typeToConfirm", { ...bold, phrase: view.confirm_phrase })}
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
                    {leaving ? tg("opening") : t("signIn")}
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
