"use client";

// The phone line on /support — P6-02. Whether the line can run (and if not,
// exactly which settings the server needs), turning it on and off, the
// owner's own number for "a person, please", and the calls: who rang, how
// it ended, the message they left, and what was said. What callers said is
// text under discussion, shown and never acted on (rule 24); every
// assistant turn is labelled automated (rule 31); a call can be erased for
// good (rule 22).
//
// P6-08: call recording — off by default, switched by the owner, with what
// it means in plain words (callers are told first, kept N days, erasable).
// A recorded call plays here for the owner only, from the owner-gated
// route; the page never learns where the audio is stored.
//
// Decision 5 (owner, 2026-11-09): recording stops before a put-through, and
// the screen says so. Decision 2: a viewer sees the calls list only — the
// number masked, no message, no "read the call" — and is told why; the
// server enforces it (GET /api/support/phone), this only follows `can_read`.

import { useCallback, useEffect, useState } from "react";
import { num } from "../sheet/num";
import { useTr } from "../sheet/useTr";
import { durationWords, whenFull } from "./support-view";

type Outcome = "answered" | "message" | "handed_over" | "hung_up";

interface Call {
  id: string;
  caller_number: string | null;
  outcome: Outcome | null;
  live: boolean;
  message: string | null;
  turns: number;
  duration_seconds: number | null;
  started_at: string;
  recorded: boolean;
  recording: { id: string; duration_seconds: number | null; expires_at: string | null } | null;
}

interface Turn {
  id: string;
  role: "caller" | "assistant";
  text: string;
  at: string;
}

interface Phone {
  missing: string[];
  number: string | null;
  voice_url: string;
  status_url: string;
  line: { phone_number: string; enabled: boolean; handover_number: string | null } | null;
  recording: {
    on: boolean;
    changed_at: string | null;
    keep_days: number;
    missing: string[];
    can_play: boolean;
  };
  /** Decision 2: transcripts, messages and full numbers are for owners and managers. */
  can_read: boolean;
  calls: Call[];
}

async function post(
  payload: Record<string, unknown>,
): Promise<{ ok: boolean; error: string | undefined }> {
  const res = await fetch("/api/support/phone", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const json = (await res.json().catch(() => ({}))) as { error?: string };
  return { ok: res.ok, error: json.error };
}

export function PhoneLine() {
  const { tr, locale } = useTr("support");
  const [phone, setPhone] = useState<Phone | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [handover, setHandover] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [confirmErase, setConfirmErase] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/support/phone");
    if (!res.ok) return;
    const j = (await res.json()) as Phone;
    setPhone(j);
    setHandover(j.line?.handover_number ?? "");
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (open === null) return;
    let live = true;
    void (async () => {
      const res = await fetch(`/api/support/phone?call=${encodeURIComponent(open)}`);
      if (!res.ok) return;
      const j = (await res.json()) as { turns: Turn[] };
      if (live) setTurns(j.turns);
    })();
    return () => {
      live = false;
    };
  }, [open]);

  const act = async (payload: Record<string, unknown>, done: string) => {
    setBusy(true);
    setNotice(null);
    const { ok, error } = await post(payload);
    if (ok) await load();
    setBusy(false);
    setConfirmErase(null);
    setNotice(ok ? done : (error ?? tr("failed")));
  };

  if (!phone) return null;
  const line = phone.line;
  const answering = line?.enabled === true;

  return (
    <section className="cs sp-widget" id="sp-phone" aria-labelledby="sp-phone-title">
      <header className="cs-head">
        <div>
          <p className="cs-label">{tr("phone.label")}</p>
          <h2 className="cs-title" id="sp-phone-title">
            {answering && line
              ? tr("phone.titleOn", { number: line.phone_number })
              : tr("phone.titleOff")}
          </h2>
        </div>
      </header>
      <div className="cs-body">
        {notice && (
          <p className="sp-notice" aria-live="polite">
            {notice}
          </p>
        )}
        <p className="sp-fine">
          {phone.recording.on ? tr("phone.whatRecorded") : tr("phone.what")}
        </p>

        {phone.missing.length > 0 ? (
          <>
            <p className="sp-prose">{tr("phone.needsKeys")}</p>
            <pre className="sp-snippet">{phone.missing.join("\n")}</pre>
          </>
        ) : (
          <>
            {!answering && phone.number && (
              <>
                <p className="sp-prose">{tr("phone.offBody", { number: phone.number })}</p>
                <button
                  type="button"
                  className="next"
                  disabled={busy}
                  onClick={() => void act({ action: "phone_on" }, tr("phone.notice.on"))}
                >
                  {tr("phone.turnOn", { number: phone.number })} <span aria-hidden="true">→</span>
                </button>
              </>
            )}
            <p className="sp-prose">{tr("phone.setUp")}</p>
            <pre className="sp-snippet">{`${phone.voice_url}\n${phone.status_url}`}</pre>
            {answering && (
              <>
                <form
                  className="sp-row"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void act(
                      { action: "set_handover", number: handover },
                      tr("phone.notice.handover"),
                    );
                  }}
                >
                  <label htmlFor="sp-handover">{tr("phone.handoverLabel")}</label>
                  <input
                    id="sp-handover"
                    className="sp-input"
                    inputMode="tel"
                    autoComplete="tel"
                    value={handover}
                    onChange={(e) => setHandover(e.target.value)}
                  />
                  <button className="act" disabled={busy}>
                    {tr("phone.handoverSave")}
                  </button>
                </form>
                <p className="sp-fine">{tr("phone.handoverHint")}</p>
                <button
                  type="button"
                  className="prop-btn quiet"
                  disabled={busy}
                  onClick={() => void act({ action: "phone_off" }, tr("phone.notice.off"))}
                >
                  {tr("phone.turnOff")}
                </button>

                <h3 className="sp-box-title">{tr("phone.recording.title")}</h3>
                <p className="sp-prose">
                  {phone.recording.on
                    ? tr("phone.recording.stateOn")
                    : tr("phone.recording.stateOff")}
                </p>
                <p className="sp-fine">
                  {tr("phone.recording.explain", {
                    days: phone.recording.keep_days,
                  })}
                </p>
                <p className="sp-fine">{tr("phone.recording.stopsOnTransfer")}</p>
                {phone.recording.changed_at && (
                  <p className="sp-fine">
                    {tr("phone.recording.changed", {
                      when: whenFull(phone.recording.changed_at, locale),
                    })}
                  </p>
                )}
                {!phone.recording.on && phone.recording.missing.length > 0 ? (
                  <>
                    <p className="sp-fine">{tr("phone.recording.needsSetup")}</p>
                    <pre className="sp-snippet">{phone.recording.missing.join("\n")}</pre>
                  </>
                ) : (
                  <button
                    type="button"
                    className={phone.recording.on ? "prop-btn quiet" : "act"}
                    disabled={busy}
                    onClick={() =>
                      void act(
                        { action: phone.recording.on ? "recording_off" : "recording_on" },
                        phone.recording.on
                          ? tr("phone.notice.recordingOff")
                          : tr("phone.notice.recordingOn"),
                      )
                    }
                  >
                    {phone.recording.on
                      ? tr("phone.recording.turnOff")
                      : tr("phone.recording.turnOn")}
                  </button>
                )}
              </>
            )}
          </>
        )}

        <h3 className="sp-box-title">{tr("phone.callsTitle")}</h3>
        {!phone.can_read && phone.calls.length > 0 && (
          <p className="sp-fine">{tr("phone.viewerNote")}</p>
        )}
        {phone.calls.length === 0 ? (
          <p className="sp-fine">{tr("phone.callsEmpty")}</p>
        ) : (
          <ol className="sp-msgs" aria-label={tr("phone.callsTitle")}>
            {phone.calls.map((c) => (
              <li key={c.id} className="sp-box">
                <p className="sp-box-label">
                  {c.caller_number ?? tr("phone.withheld")} · {whenFull(c.started_at, locale)}
                </p>
                <p className="sp-box-title">
                  {c.live || c.outcome === null
                    ? tr("phone.outcome.live")
                    : tr(`phone.outcome.${c.outcome}`)}
                </p>
                <p className="sp-fine">
                  {tr("phone.asked", { count: c.turns, n: num(c.turns, 0, locale) })}
                  {c.duration_seconds !== null &&
                    c.duration_seconds >= 60 &&
                    ` · ${durationWords(c.duration_seconds * 1000, tr, locale)}`}
                </p>
                {c.recorded && (
                  <p className="sp-fine">
                    {c.recording?.expires_at
                      ? tr("phone.recording.kept", {
                          date: whenFull(c.recording.expires_at, locale),
                        })
                      : tr("phone.recording.notKept")}
                  </p>
                )}
                {c.recording && phone.recording.can_play && (
                  // The owner-gated route opens the sealed file; preload="none"
                  // fetches nothing until the owner presses play.
                  <audio
                    controls
                    preload="none"
                    aria-label={tr("phone.recording.listen")}
                    src={`/api/support/phone/recording?call=${encodeURIComponent(c.id)}`}
                  />
                )}
                {c.message && (
                  <>
                    <p className="sp-box-label">{tr("phone.messageLabel")}</p>
                    {/* The caller's words are text under discussion — rendered, never acted on. */}
                    <p className="sp-msg-text">{c.message}</p>
                  </>
                )}
                <div className="sp-row">
                  {phone.can_read && (
                    <button
                      type="button"
                      className="prop-btn quiet"
                      onClick={() => {
                        setTurns([]);
                        setOpen(open === c.id ? null : c.id);
                      }}
                    >
                      {open === c.id ? tr("phone.hide") : tr("phone.read")}
                    </button>
                  )}
                  {/* GDPR erasure (rule 22): irreversible, so it asks twice. */}
                  <button
                    type="button"
                    className={confirmErase === c.id ? "prop-btn" : "prop-btn quiet"}
                    disabled={busy}
                    onClick={() =>
                      confirmErase === c.id
                        ? void act(
                            { action: "erase_call", call_id: c.id },
                            tr("phone.notice.erased"),
                          )
                        : setConfirmErase(c.id)
                    }
                  >
                    {confirmErase === c.id ? tr("phone.eraseYes") : tr("phone.erase")}
                  </button>
                  {confirmErase === c.id && (
                    <button
                      type="button"
                      className="prop-btn quiet"
                      onClick={() => setConfirmErase(null)}
                    >
                      {tr("phone.keep")}
                    </button>
                  )}
                </div>
                {confirmErase === c.id && (
                  <p className="sp-fine">
                    {c.recorded ? tr("phone.eraseConfirmRecorded") : tr("phone.eraseConfirm")}
                  </p>
                )}
                {open === c.id && (
                  <ol className="sp-msgs">
                    {turns.map((m) => (
                      <li
                        key={m.id}
                        className={`sp-msg ${m.role === "caller" ? "customer" : "assistant"}`}
                      >
                        <p className="sp-msg-text">{m.text}</p>
                        <p className="sp-msg-meta">
                          {m.role === "assistant" ? tr("phone.assistant") : tr("phone.caller")}
                        </p>
                      </li>
                    ))}
                  </ol>
                )}
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}
