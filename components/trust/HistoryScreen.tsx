"use client";

// The scorecard and suggestion history — Phase 3 Session E (P3-26/27).
// The decision log made legible: every suggestion ever made, what the
// owner decided, what ran, and what the measurement layer then said
// about it — helped, did nothing, backfired — with the arithmetic on
// the card. The numbers render whatever they say; a backfired verdict
// gets the same typography as a helped one.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

interface Outcome {
  verdict: "helped" | "did_nothing" | "backfired" | "too_early" | "unmeasured";
  arithmetic: string;
  predicted: string | null;
  delta_pct: number | null;
  executed_on: string | null;
}

interface Entry {
  proposal: {
    id: string;
    status: string;
    module: string;
    created_at: string;
    decided_at: string | null;
    rejection_reason: string | null;
    blocked_by_limit: string | null;
    action: { summary: string };
  };
  outcome: Outcome | null;
}

interface Scorecard {
  made: number;
  blocked: number;
  pending: number;
  approved: number;
  rejected: number;
  expired: number;
  executed: number;
  approval_rate: { value: number | null };
  outcomes: Record<Outcome["verdict"], number>;
  arithmetic: string;
}

type State =
  | { phase: "loading" }
  | { phase: "signedout" }
  | { phase: "ready"; scorecard: Scorecard; history: Entry[] };

const VERDICT_WORD: Record<Outcome["verdict"], string> = {
  helped: "helped",
  did_nothing: "did nothing",
  backfired: "backfired",
  too_early: "too early to say",
  unmeasured: "unmeasured",
};

const dateWord = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })
    : "—";

export function HistoryScreen() {
  const [state, setState] = useState<State>({ phase: "loading" });

  const load = useCallback(async () => {
    const res = await fetch("/api/trust");
    if (res.status === 401) return setState({ phase: "signedout" });
    const j = (await res.json()) as { scorecard: Scorecard; history: Entry[] };
    setState({ phase: "ready", scorecard: j.scorecard, history: j.history });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (state.phase === "loading") {
    return (
      <main className="auth-stage">
        <p className="auth-copy">Reading the record…</p>
      </main>
    );
  }
  if (state.phase === "signedout") {
    return (
      <main className="auth-stage">
        <div className="auth-col">
          <span className="wordmark">Ledgerline</span>
          <section className="card auth-card">
            <span className="auth-eyebrow">the record</span>
            <h1 className="auth-title">Nothing on file for this browser.</h1>
            <p className="auth-copy">The scorecard exists once there are suggestions to score.</p>
            <Link className="next auth-cta" style={{ marginTop: 22 }} href="/intake">
              Start
            </Link>
          </section>
        </div>
      </main>
    );
  }

  const { scorecard, history } = state;
  const cells: { label: string; value: number }[] = [
    { label: "suggested", value: scorecard.made },
    { label: "approved", value: scorecard.approved + scorecard.executed },
    { label: "declined", value: scorecard.rejected },
    { label: "helped", value: scorecard.outcomes.helped },
    { label: "did nothing", value: scorecard.outcomes.did_nothing },
    { label: "backfired", value: scorecard.outcomes.backfired },
  ];

  return (
    <main className="ops-shell">
      <header className="ops-head">
        <span className="wordmark">Ledgerline</span>
        <span className="ops-meta">
          the record ·{" "}
          {scorecard.approval_rate.value !== null
            ? `${scorecard.approval_rate.value}% approval`
            : "no decisions yet"}
        </span>
      </header>

      <section className="card ops-card">
        <span className="auth-eyebrow">the scorecard — judged by measurement, not by me</span>
        <div className="tr-grid">
          {cells.map((c) => (
            <div key={c.label} className="tr-cell">
              <span className="tr-num">{c.value}</span>
              <span className="tr-label">{c.label}</span>
            </div>
          ))}
        </div>
        <p className="conn-note">{scorecard.arithmetic}</p>
        {(scorecard.outcomes.too_early > 0 || scorecard.outcomes.unmeasured > 0) && (
          <p className="conn-note">
            {scorecard.outcomes.too_early > 0 &&
              `${scorecard.outcomes.too_early} too early to judge. `}
            {scorecard.outcomes.unmeasured > 0 &&
              `${scorecard.outcomes.unmeasured} unmeasured — a verdict needs a connected source.`}
          </p>
        )}
      </section>

      {history.length === 0 && (
        <section className="card ops-card">
          <p className="auth-copy">
            No suggestions yet. When there are, every one of them lives here forever — decision,
            execution, outcome.
          </p>
        </section>
      )}

      {history.map(({ proposal, outcome }) => (
        <section key={proposal.id} className="card ops-card">
          <div className="prop-head">
            <span className={`prop-tag ${proposal.status}`}>{proposal.status}</span>
            {outcome && outcome.verdict !== "unmeasured" && (
              <span className={`prop-tag tr-${outcome.verdict}`}>
                {VERDICT_WORD[outcome.verdict]}
                {outcome.delta_pct !== null &&
                  ` · ${outcome.delta_pct >= 0 ? "+" : ""}${outcome.delta_pct}%`}
              </span>
            )}
            <span className="conn-note" style={{ margin: 0 }}>
              {dateWord(proposal.decided_at ?? proposal.created_at)}
            </span>
          </div>
          <h2 className="prop-title small" style={{ marginTop: 10 }}>
            {proposal.action.summary}
          </h2>
          {proposal.rejection_reason && (
            <p className="conn-note">You said: “{proposal.rejection_reason}”</p>
          )}
          {proposal.blocked_by_limit && (
            <p className="conn-note">
              Withheld by your own limit: “{proposal.blocked_by_limit.replace(/^13\.5:\s*/, "")}”
            </p>
          )}
          {outcome && (
            <>
              {outcome.predicted && <p className="conn-note">Predicted: {outcome.predicted}</p>}
              <p className="tr-arith">{outcome.arithmetic}</p>
            </>
          )}
        </section>
      ))}

      <p className="conn-note">
        Every verdict above is arithmetic over measured days — nothing is graded on intention.{" "}
        <Link href="/proposals">Proposals</Link> · <Link href="/content">Content</Link> ·{" "}
        <Link href="/report">Report</Link>
      </p>
    </main>
  );
}
