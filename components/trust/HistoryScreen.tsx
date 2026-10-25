"use client";

// History — the ledger (the owner's History design, 2026-10-17), on the
// Session E record (P3-26/27). Every suggestion ever made, what the owner
// decided, what ran and what measurement then said about it, plus every
// fact that was superseded (rule 3), as one dated, append-only list. The
// figures in the head are counted from the same record; a verdict renders
// whatever it says — a backfired one gets the same typography as a helped
// one. Export writes exactly the rows on screen, in the browser.

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { PageHead, SheetCard } from "../sheet/PageHead";
import { keyWords } from "../report/figures";
import type { FactChange } from "../../lib/trust/fact-change-view";
import type { LedgerFilter, LedgerKind, LedgerOutcome, LedgerProposal, LedgerRow } from "./ledger";
import { byDay, factRow, filterRows, proposalRows, toCsv } from "./ledger";
import "../../app/history.css";

interface Entry {
  proposal: LedgerProposal;
  outcome: LedgerOutcome | null;
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
  outcomes: Record<LedgerOutcome["verdict"], number>;
  arithmetic: string;
}

type State =
  | { phase: "loading" }
  | { phase: "signedout" }
  | { phase: "error" }
  | { phase: "ready"; scorecard: Scorecard; history: Entry[]; now: number };

const TABS: { id: LedgerFilter; label: string }[] = [
  { id: "everything", label: "Everything" },
  { id: "decisions", label: "Decisions" },
  { id: "ran", label: "Ran" },
  { id: "measured", label: "Measured" },
  { id: "facts", label: "Facts changed" },
];

const KIND_WORD: Record<LedgerKind, { word: string; tone: string }> = {
  proposed: { word: "proposed", tone: "" },
  withheld: { word: "withheld", tone: "drift" },
  approved: { word: "approved", tone: "ok" },
  declined: { word: "declined", tone: "" },
  expired: { word: "expired", tone: "low" },
  ran: { word: "ran", tone: "" },
  measured: { word: "measured", tone: "ink" },
  superseded: { word: "superseded", tone: "" },
};

const EMPTY: Record<LedgerFilter, string> = {
  everything:
    "Nothing on the record yet. When there is, every suggestion, decision, run and changed fact lives here for good.",
  decisions: "No suggestions or decisions yet.",
  ran: "Nothing has run. Nothing runs without your approval.",
  measured: "No verdicts yet. A verdict needs a run and a connected source to measure it.",
  facts: "No fact has been changed since it was first recorded.",
};

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Today · Sat 17 Oct", "Wed 14 Oct" — fixed words, whatever the locale data says. */
function dayHead(at: number, now: number): string {
  const d = new Date(at);
  const words = `${WEEKDAYS[d.getDay()] ?? ""} ${String(d.getDate()).padStart(2, "0")} ${MONTHS[d.getMonth()] ?? ""}`;
  return new Date(now).toDateString() === d.toDateString() ? `Today · ${words}` : words;
}

const clock = (at: number) =>
  new Date(at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

function download(rows: readonly LedgerRow[], filter: LedgerFilter) {
  const blob = new Blob([toCsv(rows)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `syb-history-${filter}-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function HistoryScreen({ facts }: { facts: FactChange[] | null }) {
  const [state, setState] = useState<State>({ phase: "loading" });
  const [filter, setFilter] = useState<LedgerFilter>("everything");

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/trust");
      if (res.status === 401) return setState({ phase: "signedout" });
      if (!res.ok) return setState({ phase: "error" });
      const j = (await res.json()) as { scorecard: Scorecard; history: Entry[] };
      setState({ phase: "ready", scorecard: j.scorecard, history: j.history, now: Date.now() });
    } catch {
      setState({ phase: "error" });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const all = useMemo<LedgerRow[]>(() => {
    if (state.phase !== "ready") return [];
    const rows = state.history.flatMap((e) => proposalRows(e.proposal, e.outcome, state.now));
    for (const f of facts ?? []) rows.push(factRow({ ...f, label: keyWords(f.key, false) }));
    return rows;
  }, [state, facts]);

  if (state.phase === "loading") {
    return (
      <main className="screen hi-screen">
        <PageHead kicker="Your business · History" title="The ledger. Append-only." />
        <p className="hi-wait">Reading the record…</p>
      </main>
    );
  }
  if (state.phase === "signedout" || state.phase === "error") {
    return (
      <main className="screen hi-screen">
        <PageHead kicker="Your business · History" title="The ledger. Append-only." />
        <SheetCard
          label="History"
          title={
            state.phase === "signedout"
              ? "Nothing on file for this browser."
              : "The record didn't load."
          }
        >
          <p className="hi-copy">
            {state.phase === "signedout"
              ? "The ledger exists once there is a business to keep it for."
              : "Something went wrong reading the record. Refresh to try again."}
          </p>
          {state.phase === "signedout" && (
            <Link className="next" href="/intake">
              Start <span aria-hidden="true">→</span>
            </Link>
          )}
        </SheetCard>
      </main>
    );
  }

  const { scorecard } = state;
  const decided = scorecard.approved + scorecard.rejected + scorecard.executed;
  const judged =
    scorecard.outcomes.helped + scorecard.outcomes.did_nothing + scorecard.outcomes.backfired;
  const figures: { label: string; value: string }[] = [
    { label: "Decided", value: String(decided) },
    { label: "Ran", value: String(scorecard.executed) },
    ...(judged > 0 ? [{ label: "Helped", value: `${scorecard.outcomes.helped} / ${judged}` }] : []),
  ];

  const tabs = facts === null ? TABS.filter((t) => t.id !== "facts") : TABS;
  const visible = filterRows(all, filter);
  const groups = byDay(visible);

  return (
    <main className="screen hi-screen">
      <PageHead
        kicker="Your business · History"
        title="The ledger. Append-only."
        aside={
          <dl className="hi-figs">
            {figures.map((f) => (
              <div key={f.label}>
                <dt>{f.label}</dt>
                <dd>{f.value}</dd>
              </div>
            ))}
          </dl>
        }
      />

      <section className="cs hi-sheet" aria-labelledby="hi-tabs-label">
        <header className="cs-head hi-head">
          <h2 className="sr-only" id="hi-tabs-label">
            The record
          </h2>
          <div className="hi-tabs" role="group" aria-label="Show">
            {tabs.map((t) => (
              <button
                key={t.id}
                type="button"
                className="hi-tab"
                aria-pressed={filter === t.id}
                onClick={() => setFilter(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>
          {visible.length > 0 && (
            <button type="button" className="hi-export" onClick={() => download(visible, filter)}>
              Export as CSV
            </button>
          )}
        </header>

        <div className="hi-body" aria-live="polite">
          {groups.length === 0 && <p className="hi-copy hi-empty">{EMPTY[filter]}</p>}
          {groups.map((g) => (
            <section key={g.day} className="hi-day" aria-label={dayHead(g.at, state.now)}>
              <h3 className="hi-day-head">{dayHead(g.at, state.now)}</h3>
              <ol className="hi-rows">
                {g.rows.map((r) => {
                  const k = KIND_WORD[r.kind];
                  return (
                    <li key={r.key} className="hi-row">
                      <span className="hi-time">
                        {r.kind === "measured" ? "now" : r.timed ? clock(r.at) : "—"}
                      </span>
                      <span className="hi-kind">
                        <span className={`word boxed ${k.tone}`}>{k.word}</span>
                      </span>
                      <span className="hi-what">
                        <span className="hi-title">{r.title}</span>
                        <span className="hi-ref">{r.ref}</span>
                        {r.detail && <span className="hi-detail">{r.detail}</span>}
                      </span>
                      <span className="hi-actor">{r.actor}</span>
                      <span className={`hi-note${r.tone ? ` word ${r.tone}` : ""}`}>{r.note}</span>
                    </li>
                  );
                })}
              </ol>
            </section>
          ))}
        </div>

        <footer className="cs-foot hi-foot">
          <p>
            Entries can&rsquo;t be edited or removed — corrections are new entries that point back.
          </p>
          <p>Approval rate: {scorecard.arithmetic}.</p>
          {(scorecard.outcomes.too_early > 0 || scorecard.outcomes.unmeasured > 0) && (
            <p>
              {scorecard.outcomes.too_early > 0 &&
                `${scorecard.outcomes.too_early} too early to judge. `}
              {scorecard.outcomes.unmeasured > 0 &&
                `${scorecard.outcomes.unmeasured} unmeasured — a verdict needs a connected source.`}
            </p>
          )}
          <p>
            Every verdict is arithmetic over measured days, read now — nothing is graded on
            intention.
          </p>
        </footer>
      </section>
    </main>
  );
}
