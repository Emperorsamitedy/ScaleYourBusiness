"use client";

// Goal progress and alert mode — Session J (P3-42..47), on one screen.
// Per goal: whether it can be measured (and a form to make it so), the
// latest weekly verdict with its arithmetic, and — when a goal reached
// alert — what the review thinks went wrong, with how much evidence, what
// it suggested, and whether a person at Ledgerline now has the case.
// Everything here is read from /api/care; nothing on this screen acts.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { format, minorUnitExponent, money } from "../../lib/core/money";

interface Measure {
  metric: "revenue" | "orders" | "sessions";
  direction: "increase" | "decrease";
  target_per_30d: number;
  currency: string | null;
  deadline: string;
  set_on: string;
}
interface Baseline {
  per_30d: number;
  currency: string | null;
  from: string;
  to: string;
}
interface Cause {
  category: string;
  statement: string;
  evidence: string[];
}
interface Suggestion {
  kind: string;
  title: string;
  rationale: string;
  proposal_id: string | null;
  note: string | null;
}
interface CareGoal {
  goal_id: string;
  statement: string | null;
  horizon: string | null;
  measurable: boolean;
  measure: Measure | null;
  baseline: Baseline | null;
  latest_check: { at: string; detail: string; verdict: string; alert?: boolean } | null;
  review: {
    at: string;
    outcome: string;
    review: { summary: string; causes: Cause[]; suggestions: Suggestion[] } | null;
    with_a_person: boolean;
    escalation_reason: string | null;
  } | null;
}
interface CareView {
  care: { day_zero: string; watch_ends_at: string | null } | null;
  goals: CareGoal[];
}

const METRIC_WORD: Record<Measure["metric"], string> = {
  revenue: "revenue",
  orders: "orders",
  sessions: "website visits",
};

const VERDICT_WORD: Record<string, string> = {
  achieved: "reached",
  on_track: "on track",
  lagging: "behind",
  off_track: "off track",
  too_early: "too early",
  unmeasured: "not measured",
};

const CAUSE_WORD: Record<string, string> = {
  our_advice_was_wrong: "Our advice was wrong",
  goal_unrealistic: "The goal asks too much for the time",
  owner_declined_key_actions: "Key steps were declined",
  approved_actions_not_executed: "Approved steps never ran",
  execution_failed: "Something failed when it ran",
  data_incomplete: "We're missing data",
  external_change: "Something outside changed",
  other: "Something else",
};

function amount(value: number, measure: Pick<Measure, "metric" | "currency">): string {
  const shown = measure.currency ? format(money(value, measure.currency)) : String(value);
  return `${shown} ${METRIC_WORD[measure.metric]}`;
}

function MeasureForm({ goal, onSaved }: { goal: CareGoal; onSaved: () => Promise<void> }) {
  const [metric, setMetric] = useState<Measure["metric"]>("revenue");
  const [direction, setDirection] = useState<Measure["direction"]>("increase");
  const [target, setTarget] = useState("");
  const [currency, setCurrency] = useState("EUR");
  const [deadline, setDeadline] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const submit = async () => {
    const value = Number(target.replace(",", "."));
    if (!Number.isFinite(value) || value <= 0) return setMessage("Enter a target above zero.");
    const cur = currency.trim().toUpperCase();
    const target_per_30d =
      metric === "revenue" ? Math.round(value * 10 ** minorUnitExponent(cur)) : Math.round(value);
    setBusy(true);
    setMessage(null);
    const res = await fetch("/api/goals", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        goal_id: goal.goal_id,
        measure: {
          metric,
          direction,
          target_per_30d,
          currency: metric === "revenue" ? cur : null,
          deadline: deadline || null,
        },
      }),
    });
    const body = (await res.json()) as { error?: string; baseline_note?: string | null };
    setBusy(false);
    if (!res.ok) return setMessage(body.error ?? "That didn't save.");
    if (body.baseline_note) setMessage(`Saved. No starting value yet: ${body.baseline_note}.`);
    await onSaved();
  };

  return (
    <form
      className="ct-goal-form"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <select
        className="prop-select"
        value={direction}
        onChange={(e) => setDirection(e.target.value as Measure["direction"])}
      >
        <option value="increase">Raise</option>
        <option value="decrease">Lower</option>
      </select>
      <select
        className="prop-select"
        value={metric}
        onChange={(e) => setMetric(e.target.value as Measure["metric"])}
      >
        <option value="revenue">revenue</option>
        <option value="orders">orders</option>
        <option value="sessions">website visits</option>
      </select>
      <span className="conn-note">to</span>
      <input
        className="ct-input"
        style={{ minWidth: 120, flex: "0 1 140px" }}
        inputMode="decimal"
        placeholder={metric === "revenue" ? "3600" : "120"}
        value={target}
        onChange={(e) => setTarget(e.target.value)}
      />
      {metric === "revenue" && (
        <input
          className="ct-input"
          style={{ minWidth: 70, flex: "0 1 80px" }}
          aria-label="currency"
          value={currency}
          onChange={(e) => setCurrency(e.target.value)}
        />
      )}
      <span className="conn-note">per 30 days, by</span>
      <input
        className="ct-input"
        style={{ minWidth: 150, flex: "0 1 170px" }}
        type="date"
        aria-label="deadline"
        value={deadline}
        onChange={(e) => setDeadline(e.target.value)}
      />
      <button className="prop-btn" disabled={busy || target.trim() === ""}>
        Make it measurable
      </button>
      {message && (
        <p className="conn-note" style={{ width: "100%" }}>
          {message}
        </p>
      )}
      {!deadline && goal.horizon && (
        <p className="conn-note" style={{ width: "100%" }}>
          Leave the date empty and the goal&apos;s own horizon sets it.
        </p>
      )}
    </form>
  );
}

export function ProgressScreen() {
  const [view, setView] = useState<CareView | null>(null);
  const [failed, setFailed] = useState<"signed_out" | "error" | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/care");
      if (res.status === 401) return setFailed("signed_out");
      if (!res.ok) return setFailed("error");
      setView((await res.json()) as CareView);
    } catch {
      setFailed("error");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (failed) {
    return (
      <main className="auth-stage">
        <p className="auth-copy">
          {failed === "signed_out" ? (
            <>
              There&apos;s no business here yet.{" "}
              <Link href="/intake">Start with the interview</Link>.
            </>
          ) : (
            "Something went wrong loading your goals. Refresh to try again."
          )}
        </p>
      </main>
    );
  }
  if (!view) {
    return (
      <main className="auth-stage">
        <p className="auth-copy">Reading your goals…</p>
      </main>
    );
  }

  return (
    <main className="ops-shell">
      <header className="ops-head">
        <span className="wordmark">Ledgerline</span>
        <span className="ops-meta">
          goal progress
          {view.care
            ? ` · in our care since ${view.care.day_zero.slice(0, 10)}`
            : " · not in care yet"}
        </span>
      </header>

      <section className="card ops-card">
        <span className="auth-eyebrow">how this works</span>
        <p className="auth-copy" style={{ fontSize: 14 }}>
          Every week, each measurable goal is checked against a straight path from where it started
          to where you want it. Three weeks in a row well off that path and we review everything
          we&apos;ve done since you started — including whether our own advice was wrong — and
          suggest what to try next. Nothing is judged in the first eight weeks or while we&apos;re
          still watching.
        </p>
      </section>

      {view.goals.length === 0 && (
        <section className="card ops-card">
          <p className="auth-copy">
            No goals yet. <Link href="/content">Add one</Link>, then come back to make it
            measurable.
          </p>
        </section>
      )}

      {view.goals.map((g) => (
        <section key={g.goal_id} className="card ops-card">
          <span className="auth-eyebrow">
            goal
            {g.latest_check &&
              ` · ${VERDICT_WORD[g.latest_check.verdict] ?? g.latest_check.verdict}`}
            {g.latest_check?.alert && " · alert"}
          </span>
          <h2 className="auth-title" style={{ fontSize: 20 }}>
            {g.statement ?? "—"}
          </h2>

          {g.measure ? (
            <p className="auth-copy" style={{ fontSize: 14 }}>
              {g.measure.direction === "increase" ? "Raise" : "Lower"}{" "}
              {METRIC_WORD[g.measure.metric]} to {amount(g.measure.target_per_30d, g.measure)} per
              30 days by {g.measure.deadline}.{" "}
              {g.baseline
                ? `It started at ${amount(g.baseline.per_30d, g.measure)} per 30 days (measured ${g.baseline.from} to ${g.baseline.to}).`
                : "No measured starting value yet — connect a source and its history fills it in."}
            </p>
          ) : (
            <>
              <p className="auth-copy" style={{ fontSize: 14 }}>
                This goal isn&apos;t measurable yet, so we can&apos;t tell you whether it&apos;s on
                track. Name the number it should move:
              </p>
              <MeasureForm goal={g} onSaved={load} />
            </>
          )}

          {g.latest_check && (
            <p className="conn-note" style={{ marginTop: 10 }}>
              {g.latest_check.at.slice(0, 10)} — {g.latest_check.detail}
            </p>
          )}

          {g.review && (
            <div style={{ marginTop: 16 }}>
              <span className="auth-eyebrow">
                alert review · {g.review.at.slice(0, 10)}
                {g.review.with_a_person && " · a person at Ledgerline has this now"}
              </span>
              {g.review.with_a_person && (
                <p className="auth-copy" style={{ fontSize: 14 }}>
                  The automatic review has done what it can
                  {g.review.escalation_reason ? ` (${g.review.escalation_reason})` : ""}. Someone
                  from our team is looking at this goal and will be in touch.
                </p>
              )}
              {g.review.review && g.review.review.summary && (
                <>
                  <p className="auth-copy" style={{ fontSize: 14 }}>
                    {g.review.review.summary}
                  </p>
                  {g.review.review.causes.length > 0 && (
                    <ul className="mode-reasons">
                      {g.review.review.causes.map((c) => (
                        <li key={`${c.category}-${c.statement}`}>
                          <strong>{CAUSE_WORD[c.category] ?? c.category}:</strong> {c.statement}{" "}
                          <em>
                            ({c.evidence.length} piece{c.evidence.length === 1 ? "" : "s"} of
                            evidence)
                          </em>
                        </li>
                      ))}
                    </ul>
                  )}
                  {g.review.review.suggestions.length > 0 && (
                    <ul className="prop-log">
                      {g.review.review.suggestions.map((s) => (
                        <li key={`${s.kind}-${s.title}`}>
                          <span className="prop-log-title">{s.title}</span>
                          {s.proposal_id ? (
                            <span className="conn-note">
                              — waiting for you in the <Link href="/proposals">approval queue</Link>
                              {s.note ? ` (${s.note})` : ""}
                            </span>
                          ) : (
                            <span className="conn-note"> — {s.note ?? "yours to decide"}</span>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )}
            </div>
          )}
        </section>
      ))}
    </main>
  );
}
