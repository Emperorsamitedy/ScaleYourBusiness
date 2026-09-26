"use client";

// The approval queue — Phase 3 Session A (P3-05/07), ux-spec §8.
//
// An approval is always: what will happen, why, what it's based on, and
// what happens if you decline. Approve and Decline carry EQUAL visual
// weight — an interface that makes "no" the small grey option is
// manipulating the owner. Declining asks why, in the owner's words.
// The signal blue appears here at full strength and nowhere else.
//
// Below the queue: the restraint view (rule 14) — proposals the system
// wrote and then blocked against the owner's own 13.5 limits, shown so
// the restraint is visible; then decided and expired history, never
// conflated (expired is silence, rejected is a decision).

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { EmergencyStop } from "../execution/EmergencyStop";

interface Assumption {
  statement: string;
  sensitivity: "high" | "medium" | "low";
}

interface Proposal {
  id: string;
  module: string;
  status: string;
  action: {
    kind: string;
    summary: string;
    detail?: { rationale?: string; manual_limits?: string[] };
  };
  scenario: {
    assumptions: Assumption[];
    base_case?: { statement: string };
    downside_case?: { statement: string };
    breakeven_condition: string;
  };
  reversibility: { level: string; if_you_change_your_mind: string };
  blocked_by_limit: string | null;
  created_at: string;
  expires_at: string;
  decided_at: string | null;
  rejection_reason: string | null;
  execute_not_before: string | null;
}

interface Queue {
  pending: Proposal[];
  blocked: Proposal[];
  decided: Proposal[];
  expired: Proposal[];
}

type State =
  | { phase: "loading" }
  | { phase: "signedout" }
  | { phase: "ready"; queue: Queue; busy: boolean; notice: string | null };

const dateWord = (iso: string) =>
  new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });

/** Schedule choices — "now" stores nothing; the rest store a floor. */
const SCHEDULES: { key: string; label: string; days: number | null }[] = [
  { key: "now", label: "as soon as it can", days: null },
  { key: "tomorrow", label: "no earlier than tomorrow", days: 1 },
  { key: "next_week", label: "no earlier than next week", days: 7 },
];

export function QueueScreen() {
  const [state, setState] = useState<State>({ phase: "loading" });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [declining, setDeclining] = useState<string | null>(null); // proposal id or "__bulk__"
  const [reason, setReason] = useState("");
  const [schedule, setSchedule] = useState("now");

  const load = useCallback(async () => {
    const res = await fetch("/api/proposals");
    if (res.status === 401) return setState({ phase: "signedout" });
    const queue = (await res.json()) as Queue;
    setState({ phase: "ready", queue, busy: false, notice: null });
    setSelected(new Set());
    setDeclining(null);
    setReason("");
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const decide = async (ids: string[], decision: "approve" | "reject") => {
    if (state.phase !== "ready" || ids.length === 0) return;
    setState({ ...state, busy: true });
    const executeNotBefore = SCHEDULES.find((s) => s.key === schedule)?.days;
    const res = await fetch("/api/proposals", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ids,
        decision,
        ...(decision === "reject" ? { reason } : {}),
        ...(decision === "approve" && executeNotBefore
          ? {
              execute_not_before: new Date(
                Date.now() + executeNotBefore * 86_400_000,
              ).toISOString(),
            }
          : {}),
      }),
    });
    if (res.status === 401) {
      const j = (await res.json()) as { error?: string };
      setState({ ...state, busy: false, notice: j.error ?? "sign in to decide" });
      return;
    }
    await load();
  };

  const generate = async () => {
    if (state.phase !== "ready") return;
    setState({ ...state, busy: true });
    await fetch("/api/proposals", { method: "POST" });
    await load();
  };

  if (state.phase === "loading") {
    return (
      <main className="auth-stage">
        <p className="auth-copy">Reading the queue…</p>
      </main>
    );
  }

  if (state.phase === "signedout") {
    return (
      <main className="auth-stage">
        <div className="auth-col">
          <span className="wordmark">Ledgerline</span>
          <section className="card auth-card">
            <span className="auth-eyebrow">proposals</span>
            <h1 className="auth-title">Sign in to decide.</h1>
            <p className="auth-copy">
              Approving or declining a proposal is recorded with your name on it — that needs you
              signed in, not just this browser.
            </p>
            <Link className="next auth-cta" style={{ marginTop: 22 }} href="/login">
              Sign in
            </Link>
          </section>
        </div>
      </main>
    );
  }

  const { queue, busy, notice } = state;
  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const declineBox = (ids: string[]) => (
    <div className="prop-decline">
      <textarea
        className="prop-reason"
        placeholder="Why not? A sentence is enough — I learn from it."
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      <div className="prop-actions">
        <button
          className="prop-btn"
          disabled={busy || reason.trim() === ""}
          onClick={() => void decide(ids, "reject")}
        >
          Decline{ids.length > 1 ? ` ${ids.length}` : ""}
        </button>
        <button
          className="prop-btn quiet"
          onClick={() => {
            setDeclining(null);
            setReason("");
          }}
        >
          Keep it open
        </button>
      </div>
    </div>
  );

  return (
    <main className="ops-shell">
      <header className="ops-head">
        <span className="wordmark">Ledgerline</span>
        <span className="ops-meta">proposals · your decision · {queue.pending.length} waiting</span>
      </header>

      <EmergencyStop />

      {notice && (
        <section className="card ops-card">
          <p className="auth-copy" aria-live="polite">
            {notice}
          </p>
        </section>
      )}

      {queue.pending.length === 0 && (
        <section className="card ops-card">
          <span className="auth-eyebrow">nothing waiting</span>
          <h1 className="auth-title">No proposals need you.</h1>
          <p className="auth-copy">
            When I have something worth doing, it appears here first — what will happen, why, what
            it rests on, and what declining costs. Nothing runs without your yes.
          </p>
          <button
            className="next auth-cta"
            style={{ marginTop: 22 }}
            disabled={busy}
            onClick={() => void generate()}
          >
            Check the latest report for proposals
          </button>
        </section>
      )}

      {queue.pending.length > 1 && (
        <div className="prop-bulk">
          <span className="conn-note">
            {selected.size > 0 ? `${selected.size} selected` : "Select several to decide together"}
          </span>
          {selected.size > 0 && (
            <div className="prop-actions">
              <button
                className="prop-btn signal"
                disabled={busy}
                onClick={() => void decide([...selected], "approve")}
              >
                Approve {selected.size}
              </button>
              <button
                className="prop-btn"
                disabled={busy}
                onClick={() => {
                  setDeclining("__bulk__");
                  setReason("");
                }}
              >
                Decline {selected.size}
              </button>
            </div>
          )}
          {declining === "__bulk__" && declineBox([...selected])}
        </div>
      )}

      {queue.pending.map((p) => (
        <section key={p.id} className="card ops-card">
          <div className="prop-head">
            {queue.pending.length > 1 && (
              <input
                type="checkbox"
                className="prop-check"
                checked={selected.has(p.id)}
                onChange={() => toggle(p.id)}
                aria-label="select this proposal"
              />
            )}
            <span className="auth-eyebrow">
              {p.module} · decide by {dateWord(p.expires_at)}
            </span>
          </div>

          <h2 className="prop-title">{p.action.summary}</h2>
          {p.action.detail?.rationale && <p className="auth-copy">{p.action.detail.rationale}</p>}

          <span className="auth-eyebrow" style={{ marginTop: 16 }}>
            what it rests on
          </span>
          <ul className="mode-reasons">
            {p.scenario.assumptions.map((a) => (
              <li key={a.statement}>
                {a.statement}
                {a.sensitivity === "high" ? " — the conclusion leans hard on this" : ""}
              </li>
            ))}
            <li>{p.scenario.breakeven_condition}</li>
          </ul>

          <span className="auth-eyebrow" style={{ marginTop: 16 }}>
            if you decline
          </span>
          <p className="auth-copy">
            Nothing happens — declining is a real answer and I record why.{" "}
            {p.reversibility.if_you_change_your_mind}
          </p>

          {(p.action.detail?.manual_limits?.length ?? 0) > 0 && (
            <p className="prop-manual">
              You told me: “{p.action.detail?.manual_limits?.join("” · “")}” — weigh this against
              that yourself; I can&rsquo;t check it for you.
            </p>
          )}

          <div className="prop-schedule">
            <label className="conn-note" htmlFor={`sched-${p.id}`}>
              If approved, run
            </label>
            <select
              id={`sched-${p.id}`}
              className="prop-select"
              value={schedule}
              onChange={(e) => setSchedule(e.target.value)}
            >
              {SCHEDULES.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>

          <div className="prop-actions">
            <button
              className="prop-btn signal"
              disabled={busy}
              onClick={() => void decide([p.id], "approve")}
            >
              Approve
            </button>
            <button
              className="prop-btn"
              disabled={busy}
              onClick={() => {
                setDeclining(p.id);
                setReason("");
              }}
            >
              Decline
            </button>
          </div>
          {declining === p.id && declineBox([p.id])}
        </section>
      ))}

      {queue.blocked.length > 0 && (
        <section className="card ops-card">
          <span className="auth-eyebrow">held back, on your instruction</span>
          {queue.blocked.map((p) => (
            <div key={p.id} className="card ops-card prop-muted">
              <h3 className="prop-title small">{p.action.summary}</h3>
              <p className="conn-note">
                I wrote this up and then blocked it myself — you said “
                {p.blocked_by_limit?.replace(/^13\.5:\s*/, "")}”. It will not be proposed.
              </p>
            </div>
          ))}
        </section>
      )}

      {(queue.decided.length > 0 || queue.expired.length > 0) && (
        <section className="card ops-card">
          <span className="auth-eyebrow">already handled</span>
          <ul className="prop-log">
            {queue.decided.map((p) => (
              <li key={p.id}>
                <span className={`prop-tag ${p.status}`}>{p.status}</span>
                <span className="prop-log-title">{p.action.summary}</span>
                {p.rejection_reason && <span className="conn-note"> — “{p.rejection_reason}”</span>}
                {p.status === "approved" && p.execute_not_before && (
                  <span className="conn-note">
                    {" "}
                    — runs {dateWord(p.execute_not_before)} at the earliest
                  </span>
                )}
              </li>
            ))}
            {queue.expired.map((p) => (
              <li key={p.id}>
                <span className="prop-tag expired">expired</span>
                <span className="prop-log-title">{p.action.summary}</span>
                <span className="conn-note"> — ran out of time undecided; not a no</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <p className="conn-note">
        Nothing on this screen runs without your yes, and everything decided here is recorded with
        your name and your words. <Link href="/report">See the report</Link> ·{" "}
        <Link href="/watch">Watching</Link> · <Link href="/connections">Connections</Link>
      </p>
    </main>
  );
}
