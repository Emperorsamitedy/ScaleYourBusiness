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

import { useState } from "react";
import { emailConsentLines, senderIdentity } from "../../lib/execution/email-sender";

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
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(view.suggested_sender);
  const [replyTo, setReplyTo] = useState("");
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const c = view.connection;
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
        setError(out.error ?? "That didn't connect.");
        return;
      }
      setOpen(false);
      setTyped("");
      setNotice("Campaign email is granted, and your consent is on record.");
      await onChanged();
    } catch {
      setError("I couldn't reach the server. Try again.");
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
        setError(out.error ?? "That didn't disconnect.");
        return;
      }
      setNotice("Campaign email is disconnected. Nothing more will send.");
      await onChanged();
    } catch {
      setError("I couldn't reach the server. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="cn-write cn-email-wrap" aria-label="Campaign email">
      <section className="cs cn-write-card cn-email" aria-labelledby="cn-email-title">
        <header className="cs-head">
          <div>
            <p className="cs-label">Campaign email · a separate consent</p>
            <h2 className="cs-title" id="cn-email-title">
              {c ? "Granted, only for what you approve" : "Off. Nothing can email your customers."}
            </h2>
          </div>
        </header>
        <div className="cs-body cn-write-body">
          <div className="cn-wp">
            <div className="cn-wp-head">
              <div>
                <h3 className="cn-wp-name">{view.label}</h3>
                <p className="cn-wp-state">
                  {c ? `consented ${c.created_at.slice(0, 10)} · ${c.status}` : "not granted"}
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
                  {open ? "Close" : "Grant"}
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
                  <dt>status</dt>
                  <dd>
                    <span className={`word ${c.status === "connected" ? "ok" : "alarm"}`}>
                      {c.status}
                    </span>
                  </dd>
                  <dt>sent as</dt>
                  <dd>{c.sender_name} via SYB</dd>
                  <dt>replies go to</dt>
                  <dd>{c.reply_to}</dd>
                </dl>
                <div className="cn-acts">
                  <button
                    type="button"
                    className="ghost"
                    disabled={busy}
                    onClick={() => void disconnect()}
                  >
                    {busy ? "Disconnecting…" : "Disconnect"}
                  </button>
                </div>
                <p className="cn-note">{view.disconnect_note}</p>
              </div>
            )}
            {c === null && open && (
              <div className="cn-wp-detail" id="cn-grant-email">
                <p className="cn-sub">What it does</p>
                <ul className="cn-list">
                  {view.operations.map((o) => (
                    <li key={o.op}>
                      {o.description}{" "}
                      {o.reversible
                        ? "Can be undone."
                        : "Can't be undone: a sent email can't be recalled, and each campaign is labelled so before you approve it."}
                    </li>
                  ))}
                </ul>
                <p className="cn-note">
                  Campaigns go out from SYB&rsquo;s own email service, under your business name. You
                  don&rsquo;t give SYB any password or key for this.
                </p>
                <form className="cn-form" onSubmit={(e) => void grant(e)}>
                  <label className="cn-field">
                    <span className="cn-field-label">Send as (your business name)</span>
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
                    <span className="cn-field-label">Replies go to (an address you read)</span>
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
                      To confirm, type <strong>{view.confirm_phrase}</strong>
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
                    {busy ? "Recording…" : "Allow campaign email"}
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
        <footer className="cs-foot">{view.nothing_sent}</footer>
      </section>

      <section className="cn-access" aria-labelledby="cn-email-how">
        <p className="cn-access-label">How campaigns are sent</p>
        <h2 className="cn-access-title" id="cn-email-how">
          From SYB&rsquo;s own email service, under your name.
        </h2>
        <p className="cn-access-body">
          You give SYB no password or key for this. Each campaign goes only to customers who
          explicitly agreed to hear from you, each one checked again at the moment it goes, and
          every email carries its own unsubscribe link, honoured at once and for good.
        </p>
        {view.real_sends && <p className="cn-access-body">{view.real_sends}</p>}
        {view.shared_sender && <p className="cn-access-body">{view.shared_sender}</p>}
      </section>
    </div>
  );
}
