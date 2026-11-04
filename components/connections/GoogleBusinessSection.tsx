"use client";

// Google Business Profile on /connections — I-45a, rule 13.
//
// Its own section under write access, because Google's only Business
// Profile permission can write (reply to reviews, edit the listing), even
// though SYB uses it only to read reviews. The section says that plainly,
// renders the registry's consent lines verbatim, asks for a typed phrase
// before sending the owner to Google, lets them pick a location when they
// manage several, and revokes in one confirmed click.
//
// L-3d: the section's words are the "connections.google" catalogue, with
// the lines /reviews shares from "reviews.google". The consent lines and
// the phrase stay the registry's English: the consent's hash covers them.

import { useEffect, useState } from "react";
import { isGoogleReason } from "../../lib/google-business/reasons";
import { bold, useCn, useSaid } from "./useCn";
import { GOOGLE_NEED_KEYS, storedDay } from "./words";

export interface GoogleView {
  label: string;
  configured: boolean;
  not_set_up: string | null;
  what_it_can_do: string;
  consent: string[];
  scope: string;
  needs: string[];
  confirm_phrase: string;
  nothing_written: string;
  revoke_note: string;
  connection: {
    id: string;
    status: "connected" | "paused" | "failed" | "disconnected";
    granted_scopes: string[];
    last_error: string | null;
    created_at: string;
  } | null;
  location_title: string | null;
  last_read: { at: string; words: string | null } | null;
  pick: { id: string; title: string }[] | null;
}

/** What Google's redirect back to /connections says, read once from the URL. */
function readReturn(): { kind: string; reason: string | null } | null {
  const q = new URLSearchParams(window.location.search);
  const kind = q.get("google");
  if (kind !== "connected" && kind !== "pick" && kind !== "cancelled" && kind !== "error") {
    return null;
  }
  return { kind, reason: q.get("reason") };
}

function clearReturn(): void {
  const url = new URL(window.location.href);
  for (const key of ["google", "reason"]) url.searchParams.delete(key);
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

export function GoogleBusinessSection({
  view,
  onChanged,
}: {
  view: GoogleView;
  onChanged: () => Promise<void>;
}) {
  const { t, locale } = useCn("connections.google");
  const { t: tg } = useCn("reviews.google");
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
    if (back.kind === "connected") {
      setNotice(t("connected"));
    } else if (back.kind === "pick") {
      setNotice(t("signedInPick"));
    } else if (back.kind === "cancelled") {
      setNotice(t("youCancelled"));
    } else {
      // A code from the closed set, never text from the URL (lib/google-business/reasons).
      setError(t(isGoogleReason(back.reason) ? `reason.${back.reason}` : "reason.generic"));
    }
  }, []);

  const c = view.connection;
  const status = (s: string) => (t.has(`status.${s}`) ? t(`status.${s}`) : s);
  const confirmed = typed.trim().toLowerCase() === view.confirm_phrase;

  const finish = async () => {
    setBusy(true);
    setError(null);
    try {
      const out = await call("/api/connections/google-business/finish", "POST", {
        location: picked,
      });
      if (!out.ok) {
        setError(out.error !== null ? said(out.error) : t("connectFailed"));
      } else {
        setNotice(t("connected"));
      }
      await onChanged();
    } catch {
      setError(t("unreachable"));
    } finally {
      setBusy(false);
    }
  };

  const forgetPick = async () => {
    setBusy(true);
    try {
      await call("/api/connections/google-business", "DELETE", { pending: true });
      setNotice(t("nothingConnected"));
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
      const out = await call("/api/connections/google-business", "DELETE", { id: c.id });
      if (!out.ok) {
        setError(out.error !== null ? said(out.error) : t("revokeFailed"));
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
    <div className="cn-write cn-email-wrap" aria-label={tg("label")}>
      <section className="cs cn-write-card cn-email" aria-labelledby="cn-google-title">
        <header className="cs-head">
          <div>
            <p className="cs-label">{t("sectionLabel")}</p>
            <h2 className="cs-title" id="cn-google-title">
              {c ? (c.status === "failed" ? tg("failed") : t("title.on")) : t("title.off")}
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
              {c === null && view.pick === null && view.configured && (
                <button
                  type="button"
                  className="prop-btn"
                  aria-expanded={open}
                  aria-controls="cn-grant-google"
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
            <p className="cn-note">{tg("whatItCanDo")}</p>
            <ul className="cn-consent">
              {view.consent.map((line) => (
                <li key={line}>
                  <span className="cn-consent-why">{line}</span>
                  <span className="cn-scope">{view.scope}</span>
                </li>
              ))}
            </ul>
            {c === null && !view.configured && view.not_set_up && (
              <p className="cn-note">{tg("notSetUp")}</p>
            )}
            {c === null && (
              <div className="cn-wp-detail">
                <p className="cn-sub">{tg("before")}</p>
                <ul className="cn-list">
                  {view.needs.map((n, i) => {
                    const key = GOOGLE_NEED_KEYS[i];
                    return <li key={n}>{key ? tg(`needs.${key}`) : n}</li>;
                  })}
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
                  {view.location_title && (
                    <>
                      <dt>{t("fact.location")}</dt>
                      <dd>{view.location_title}</dd>
                    </>
                  )}
                  <dt>{t("fact.lastRead")}</dt>
                  <dd>
                    {view.last_read
                      ? `${storedDay(view.last_read.at, locale)}${view.last_read.words ? ` · ${view.last_read.words}` : ""}`
                      : t("fact.notYet")}
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
            {c === null && view.pick !== null && (
              <div className="cn-wp-detail">
                <p className="cn-sub">{t("pickTitle")}</p>
                <ul className="cn-list">
                  {view.pick.map((l) => (
                    <li key={l.id}>
                      <label>
                        <input
                          type="radio"
                          name="google-location"
                          value={l.id}
                          checked={picked === l.id}
                          onChange={() => setPicked(l.id)}
                          disabled={busy}
                        />{" "}
                        {l.title}
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
                    {busy ? t("recording") : t("readLocation")}
                  </button>
                  <button
                    type="button"
                    className="ghost"
                    disabled={busy}
                    onClick={() => void forgetPick()}
                  >
                    {t("cancel")}
                  </button>
                </div>
              </div>
            )}
            {c === null && view.pick === null && view.configured && open && (
              <div className="cn-wp-detail" id="cn-grant-google">
                <p className="cn-note">{t("googleScreen")}</p>
                <form
                  className="cn-form"
                  method="post"
                  action="/api/connections/google-business/start"
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
