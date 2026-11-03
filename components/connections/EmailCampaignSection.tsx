"use client";

// Campaign email on /connections — P4-15 (Phase 4 Session F), rule 13.
//
// Its own section, apart from the read-only panel and from Meta's write
// access, because what is granted here is different in kind: no token of
// the owner's, only permission for SYB's own email service to send the
// campaigns they approve, under a name and a reply address they choose.
// The consent lines are the registry's, verbatim, with the sender filled
// in as the owner types it — by the same function the consent hash uses —
// so what is shown is exactly what is recorded. A typed phrase, not a
// click, grants it; disconnect is one click.
//
// L-3d: the section's words are the "connections.email" catalogue. The
// consent lines and the phrase stay the registry's English, because the
// consent's hash covers them as shown and typed.

import { useState } from "react";
import { emailConsentLines, senderIdentity } from "../../lib/execution/email-sender";
import { bold, useCn } from "./useCn";
import { storedDay } from "./words";

export interface EmailView {
  label: string;
  consent: string[] | null;
  consent_template: string[];
  operations: { op: string; description: string; reversible: boolean }[];
  confirm_phrase: string;
  suggested_sender: string;
  nothing_sent: string;
  disconnect_note: string;
  /** The real-send switch, in the engine's own sentence, while it is off. */
  real_sends: string | null;
  /** Review #5a: said while campaigns and sign-in share one sending address. */
  shared_sender: string | null;
  connection: {
    id: string;
    status: "connected" | "paused" | "failed" | "disconnected";
    granted_scopes: string[];
    sender_name: string | null;
    reply_to: string | null;
    created_at: string;
  } | null;
}

async function call(method: "POST" | "DELETE", body: unknown) {
  const res = await fetch("/api/connections/email", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await res.json().catch(() => null)) as { error?: unknown } | null;
  return { ok: res.ok, error: typeof payload?.error === "string" ? payload.error : null };
}

export function EmailCampaignSection({
  view,
  onChanged,
}: {
  view: EmailView;
  onChanged: () => Promise<void>;
}) {
  const { t, locale } = useCn("connections.email");
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(view.suggested_sender);
  const [replyTo, setReplyTo] = useState("");
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const c = view.connection;
  const status = (s: string) => (t.has(`status.${s}`) ? t(`status.${s}`) : s);
  const ready = name.trim() !== "" && replyTo.trim() !== "";
  const confirmed = typed.trim().toLowerCase() === view.confirm_phrase;
  const lines =
    view.consent ??
    (ready
      ? emailConsentLines(senderIdentity(name, replyTo))
      : view.consent_template.map((l) =>
          l.split("{sender}").join("the name and address you give below"),
        ));

  const grant = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const out = await call("POST", { sender_name: name, reply_to: replyTo, confirmation: typed });
      if (!out.ok) {
        setError(out.error ?? t("connectFailed"));
        return;
      }
      setOpen(false);
      setTyped("");
      setNotice(t("granted"));
      await onChanged();
    } catch {
      setError(t("unreachable"));
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    if (!c) return;
    setBusy(true);
    setError(null);
    try {
      const out = await call("DELETE", { id: c.id });
      if (!out.ok) {
        setError(out.error ?? t("disconnectFailed"));
        return;
      }
      setNotice(t("disconnected"));
      await onChanged();
    } catch {
      setError(t("unreachable"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="cn-write cn-email-wrap" aria-label={t("aria")}>
      <section className="cs cn-write-card cn-email" aria-labelledby="cn-email-title">
        <header className="cs-head">
          <div>
            <p className="cs-label">{t("sectionLabel")}</p>
            <h2 className="cs-title" id="cn-email-title">
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
                    : t("notGranted")}
                </p>
              </div>
              {c === null && (
                <button
                  type="button"
                  className="prop-btn"
                  aria-expanded={open}
                  aria-controls="cn-grant-email"
                  onClick={() => setOpen(!open)}
                >
                  {open ? t("close") : t("grant")}
                </button>
              )}
            </div>
            <ul className="cn-consent">
              {lines.map((line) => (
                <li key={line}>
                  <span className="cn-consent-why">{line}</span>
                  <span className="cn-scope">
                    {c ? c.granted_scopes.join(" · ") : "email.send_marketing"}
                  </span>
                </li>
              ))}
            </ul>
            {c !== null && (
              <div className="cn-wp-detail">
                <dl className="cn-facts">
                  <dt>{t("fact.status")}</dt>
                  <dd>
                    <span className={`word ${c.status === "connected" ? "ok" : "alarm"}`}>
                      {status(c.status)}
                    </span>
                  </dd>
                  <dt>{t("fact.sentAs")}</dt>
                  <dd>{t("fact.viaSyb", { name: c.sender_name ?? "" })}</dd>
                  <dt>{t("fact.repliesTo")}</dt>
                  <dd>{c.reply_to}</dd>
                </dl>
                <div className="cn-acts">
                  <button
                    type="button"
                    className="ghost"
                    disabled={busy}
                    onClick={() => void disconnect()}
                  >
                    {busy ? t("disconnecting") : t("disconnect")}
                  </button>
                </div>
                <p className="cn-note">{t("disconnectNote")}</p>
              </div>
            )}
            {c === null && open && (
              <div className="cn-wp-detail" id="cn-grant-email">
                <p className="cn-sub">{t("whatItDoes")}</p>
                <ul className="cn-list">
                  {view.operations.map((o) => (
                    <li key={o.op}>
                      {t.has(`op.${o.op}`) ? t(`op.${o.op}`) : o.description}{" "}
                      {o.reversible ? t("undoable") : t("notUndoable")}
                    </li>
                  ))}
                </ul>
                <p className="cn-note">{t("ownService")}</p>
                <form className="cn-form" onSubmit={(e) => void grant(e)}>
                  <label className="cn-field">
                    <span className="cn-field-label">{t("sendAs")}</span>
                    <input
                      className="cn-input"
                      type="text"
                      autoComplete="organization"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      disabled={busy}
                    />
                  </label>
                  <label className="cn-field">
                    <span className="cn-field-label">{t("repliesTo")}</span>
                    <input
                      className="cn-input"
                      type="email"
                      autoComplete="email"
                      placeholder="hello@yourbusiness.com"
                      value={replyTo}
                      onChange={(e) => setReplyTo(e.target.value)}
                      disabled={busy}
                    />
                  </label>
                  <label className="cn-field">
                    <span className="cn-field-label">
                      {t.rich("typeToConfirm", { ...bold, phrase: view.confirm_phrase })}
                    </span>
                    <input
                      className="cn-input"
                      type="text"
                      autoComplete="off"
                      spellCheck={false}
                      value={typed}
                      onChange={(e) => setTyped(e.target.value)}
                      disabled={busy}
                    />
                  </label>
                  <button className="next" type="submit" disabled={busy || !ready || !confirmed}>
                    {busy ? t("recording") : t("allow")}
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
        <footer className="cs-foot">{t("nothingSent")}</footer>
      </section>

      <section className="cn-access" aria-labelledby="cn-email-how">
        <p className="cn-access-label">{t("how.label")}</p>
        <h2 className="cn-access-title" id="cn-email-how">
          {t("how.title")}
        </h2>
        <p className="cn-access-body">{t("how.body")}</p>
        {view.real_sends && (
          <p className="cn-access-body">
            {locale === "en" ? view.real_sends : t("realSendsOff", { label: t("label") })}
          </p>
        )}
        {view.shared_sender && (
          <p className="cn-access-body">
            {locale === "en" ? view.shared_sender : t("sharedSender")}
          </p>
        )}
      </section>
    </div>
  );
}
