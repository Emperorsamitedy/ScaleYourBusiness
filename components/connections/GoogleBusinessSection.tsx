"use client";

// Google Business Profile on /connections — I-45a, rule 13.
//
// Its own section under write access, because Google's only Business
// Profile permission can write (reply to reviews, edit the listing), even
// though SYB uses it only to read reviews. The section says that plainly,
// renders the registry's consent lines verbatim, asks for a typed phrase
// before sending the owner to Google, lets them pick a location when they
// manage several, and revokes in one confirmed click.

import { useEffect, useState } from "react";
import { googleReasonMessage } from "../../lib/google-business/reasons";

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
      setNotice("Google Business Profile is connected, and your consent is on record.");
    } else if (back.kind === "pick") {
      setNotice("Signed in with Google. Pick the location SYB should read.");
    } else if (back.kind === "cancelled") {
      setNotice("You cancelled on Google's screen. Nothing was connected.");
    } else {
      setError(googleReasonMessage(back.reason));
    }
  }, []);

  const c = view.connection;
  const confirmed = typed.trim().toLowerCase() === view.confirm_phrase;

  const finish = async () => {
    setBusy(true);
    setError(null);
    try {
      const out = await call("/api/connections/google-business/finish", "POST", {
        location: picked,
      });
      if (!out.ok) {
        setError(out.error ?? "That didn't connect.");
      } else {
        setNotice("Google Business Profile is connected, and your consent is on record.");
      }
      await onChanged();
    } catch {
      setError("I couldn't reach the server. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const forgetPick = async () => {
    setBusy(true);
    try {
      await call("/api/connections/google-business", "DELETE", { pending: true });
      setNotice("Nothing was connected.");
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
        setError(out.error ?? "That didn't revoke.");
        return;
      }
      setConfirmRevoke(false);
      setNotice("Revoked. SYB's access to Google is deleted, and reading has stopped.");
      await onChanged();
    } catch {
      setError("I couldn't reach the server. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="cn-write cn-email-wrap" aria-label="Google Business Profile">
      <section className="cs cn-write-card cn-email" aria-labelledby="cn-google-title">
        <header className="cs-head">
          <div>
            <p className="cs-label">Google Business Profile · a separate consent</p>
            <h2 className="cs-title" id="cn-google-title">
              {c
                ? c.status === "failed"
                  ? "Google stopped accepting SYB's access"
                  : "Granted, used only to read your reviews"
                : "Off. SYB doesn't read your Google reviews."}
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
                    ? `consented ${c.created_at.slice(0, 10)} · ${c.status}`
                    : view.configured
                      ? "not granted"
                      : "not set up yet"}
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
                  {open ? "Close" : "Connect"}
                </button>
              )}
              {c === null && !view.configured && (
                <button type="button" className="ghost" disabled>
                  Connect
                </button>
              )}
            </div>
            <p className="cn-note">{view.what_it_can_do}</p>
            <ul className="cn-consent">
              {view.consent.map((line) => (
                <li key={line}>
                  <span className="cn-consent-why">{line}</span>
                  <span className="cn-scope">{view.scope}</span>
                </li>
              ))}
            </ul>
            {c === null && !view.configured && view.not_set_up && (
              <p className="cn-note">{view.not_set_up}</p>
            )}
            {c === null && (
              <div className="cn-wp-detail">
                <p className="cn-sub">Before it can work</p>
                <ul className="cn-list">
                  {view.needs.map((n) => (
                    <li key={n}>{n}</li>
                  ))}
                </ul>
              </div>
            )}
            {c !== null && (
              <div className="cn-wp-detail">
                <dl className="cn-facts">
                  <dt>status</dt>
                  <dd>
                    <span className={`word ${c.status === "connected" ? "ok" : "alarm"}`}>
                      {c.status}
                    </span>
                  </dd>
                  {view.location_title && (
                    <>
                      <dt>location</dt>
                      <dd>{view.location_title}</dd>
                    </>
                  )}
                  <dt>last read</dt>
                  <dd>
                    {view.last_read
                      ? `${view.last_read.at.slice(0, 10)}${view.last_read.words ? ` · ${view.last_read.words}` : ""}`
                      : "not yet: SYB reads once a day"}
                  </dd>
                </dl>
                {c.last_error && <p className="cn-error">{c.last_error}</p>}
                <div className="cn-acts">
                  {confirmRevoke ? (
                    <>
                      <span className="cn-note">SYB stops reading your Google reviews.</span>
                      <button
                        type="button"
                        className="ghost"
                        disabled={busy}
                        onClick={() => void revoke()}
                      >
                        {busy ? "Revoking…" : "Yes, revoke"}
                      </button>
                      <button
                        type="button"
                        className="ghost"
                        onClick={() => setConfirmRevoke(false)}
                      >
                        Keep it
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="ghost"
                      disabled={busy}
                      onClick={() => setConfirmRevoke(true)}
                    >
                      Revoke
                    </button>
                  )}
                </div>
                <p className="cn-note">{view.revoke_note}</p>
              </div>
            )}
            {c === null && view.pick !== null && (
              <div className="cn-wp-detail">
                <p className="cn-sub">Pick the location SYB reads</p>
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
                    {busy ? "Recording…" : "Read this location's reviews"}
                  </button>
                  <button
                    type="button"
                    className="ghost"
                    disabled={busy}
                    onClick={() => void forgetPick()}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
            {c === null && view.pick === null && view.configured && open && (
              <div className="cn-wp-detail" id="cn-grant-google">
                <p className="cn-note">
                  Google then shows its own screen and asks about this one permission. Allow it, and
                  come back here.
                </p>
                <form
                  className="cn-form"
                  method="post"
                  action="/api/connections/google-business/start"
                  onSubmit={() => setLeaving(true)}
                >
                  <label className="cn-field">
                    <span className="cn-field-label">
                      To confirm, type <strong>{view.confirm_phrase}</strong>
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
                    {leaving ? "Opening Google…" : "Sign in with Google and allow reading reviews"}
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
        <footer className="cs-foot">{view.nothing_written}</footer>
      </section>
    </div>
  );
}
