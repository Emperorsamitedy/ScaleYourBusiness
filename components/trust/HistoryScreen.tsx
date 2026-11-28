"use client";

// History — the ledger (the owner's History design, 2026-10-17), on the
// Session E record (P3-26/27), with SYB's own forecast track record above
// it (idea 54, ./TrackRecord). Every suggestion ever made, what the owner
// decided, what ran and what measurement then said about it, plus every
// fact that was superseded (rule 3), as one dated, append-only list. The
// figures in the head are counted from the same record; a verdict renders
// whatever it says — a backfired one gets the same typography as a helped
// one. Export writes exactly the rows on screen, in the browser.

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useAppLocale, useTr } from "../sheet/useTr";
import { num } from "../sheet/num";
import type { AppLocale } from "../../lib/i18n/locales";
import { intlTag } from "../../lib/i18n/locales";
import { PageHead, SheetCard } from "../sheet/PageHead";
import { keyWords } from "../report/figures";
import type { TrackView } from "../../lib/forecasts/view";
import type { FactChange } from "../../lib/trust/fact-change-view";
import type { LedgerFilter, LedgerKind, LedgerOutcome, LedgerProposal, LedgerRow } from "./ledger";
import { byDay, factRow, filterRows, proposalRows, rateArithmetic, toCsv } from "./ledger";
import { TrackRecord } from "./TrackRecord";
import { WhyFold } from "../report/WhyFold";
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
  approval_rate: { numerator: number; denominator: number; value: number | null };
  outcomes: Record<LedgerOutcome["verdict"], number>;
  arithmetic: string;
}

type State =
  | { phase: "loading" }
  | { phase: "signedout" }
  | { phase: "error" }
  | { phase: "ready"; scorecard: Scorecard; history: Entry[]; now: number };

const TABS: LedgerFilter[] = ["everything", "decisions", "ran", "measured", "facts"];

const KIND_TONE: Record<LedgerKind, string> = {
  proposed: "",
  withheld: "drift",
  approved: "ok",
  declined: "",
  expired: "low",
  ran: "",
  measured: "ink",
  superseded: "",
};

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Sat 17 Oct", "Wed 14 Oct" — fixed words in English; another language writes its own. */
function dayWords(at: number, locale: AppLocale): string {
  const d = new Date(at);
  if (locale !== "en") {
    return new Intl.DateTimeFormat(intlTag(locale), {
      weekday: "short",
      day: "2-digit",
      month: "short",
    }).format(d);
  }
  return `${WEEKDAYS[d.getDay()] ?? ""} ${String(d.getDate()).padStart(2, "0")} ${MONTHS[d.getMonth()] ?? ""}`;
}

const clock = (at: number, locale: AppLocale) =>
  new Date(at).toLocaleTimeString(locale === "en" ? "en-GB" : intlTag(locale), {
    hour: "2-digit",
    minute: "2-digit",
  });

function download(
  rows: readonly LedgerRow[],
  filter: LedgerFilter,
  heading: (column: string) => string,
) {
  const blob = new Blob([toCsv(rows, heading)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `syb-history-${filter}-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function HistoryScreen({
  facts,
  track = null,
}: {
  facts: FactChange[] | null;
  track?: TrackView | null;
}) {
  const t = useTranslations("history");
  /** L-6: the CSV's headings in the reader's language. */
  const tCsv = useTranslations("exports.history");
  const locale = useAppLocale();
  // L-4a: the ledger's own words in the reader's language (components/trust/ledger).
  const lwTr = useTr("ledgerWords").tr;
  const lw = useMemo(() => ({ tr: lwTr, locale }), [lwTr, locale]);
  const n = (x: number) => num(x, 0, locale);
  /** "Today · Sat 17 Oct" for today's group. */
  const dayHead = (at: number, now: number): string => {
    const words = dayWords(at, locale);
    return new Date(now).toDateString() === new Date(at).toDateString()
      ? t("today", { day: words })
      : words;
  };
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
    const rows = state.history.flatMap((e) => proposalRows(e.proposal, e.outcome, state.now, lw));
    for (const f of facts ?? [])
      rows.push(factRow({ ...f, label: f.label ?? keyWords(f.key, false) }, lw));
    return rows;
  }, [state, facts, lw]);

  if (state.phase === "loading") {
    return (
      <main className="screen hi-screen">
        <PageHead kicker={t("kicker")} title={t("title")} />
        <p className="hi-wait">{t("reading")}</p>
      </main>
    );
  }
  if (state.phase === "signedout" || state.phase === "error") {
    return (
      <main className="screen hi-screen">
        <PageHead kicker={t("kicker")} title={t("title")} />
        <SheetCard
          label={t("label")}
          title={state.phase === "signedout" ? t("signedOut.title") : t("failed.title")}
        >
          {state.phase === "error" && <p className="hi-copy">{t("failed.lede")}</p>}
          {state.phase === "signedout" && (
            <Link className="next" href="/start">
              {t("signedOut.start")} <span aria-hidden="true">→</span>
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
    { label: t("figs.decided"), value: n(decided) },
    { label: t("figs.ran"), value: n(scorecard.executed) },
    ...(judged > 0
      ? [{ label: t("figs.helped"), value: `${n(scorecard.outcomes.helped)} / ${n(judged)}` }]
      : []),
    ...(track && !track.too_soon
      ? [{ label: t("figs.inside"), value: `${n(track.inside)} / ${n(track.graded)}` }]
      : []),
  ];

  const tabs = facts === null ? TABS.filter((id) => id !== "facts") : TABS;
  const visible = filterRows(all, filter);
  const groups = byDay(visible);

  return (
    <main className="screen hi-screen">
      <PageHead
        kicker={t("kicker")}
        title={t("title")}
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

      {track && <TrackRecord track={track} />}

      <section className="cs hi-sheet" aria-labelledby="hi-tabs-label">
        <header className="cs-head hi-head">
          <h2 className="sr-only" id="hi-tabs-label">
            {t("record")}
          </h2>
          <div className="hi-tabs" role="group" aria-label={t("show")}>
            {tabs.map((id) => (
              <button
                key={id}
                type="button"
                className="hi-tab"
                aria-pressed={filter === id}
                onClick={() => setFilter(id)}
              >
                {t(`tab.${id}`)}
              </button>
            ))}
          </div>
          {visible.length > 0 && (
            <button
              type="button"
              className="hi-export"
              onClick={() => download(visible, filter, (c) => tCsv(c as "when"))}
            >
              {t("export")}
            </button>
          )}
        </header>

        <div className="hi-body" aria-live="polite">
          {groups.length === 0 && <p className="hi-copy hi-empty">{t(`empty.${filter}`)}</p>}
          {groups.map((g) => (
            <section key={g.day} className="hi-day" aria-label={dayHead(g.at, state.now)}>
              <h3 className="hi-day-head">{dayHead(g.at, state.now)}</h3>
              <ol className="hi-rows">
                {g.rows.map((r) => {
                  const tone = KIND_TONE[r.kind];
                  return (
                    <li key={r.key} className="hi-row">
                      <span className="hi-time">
                        {r.kind === "measured" ? t("now") : r.timed ? clock(r.at, locale) : "-"}
                      </span>
                      <span className="hi-kind">
                        <span className={`word boxed ${tone}`}>{t(`kind.${r.kind}`)}</span>
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
          {(scorecard.outcomes.too_early > 0 || scorecard.outcomes.unmeasured > 0) && (
            <p>
              {scorecard.outcomes.too_early > 0 &&
                `${t("foot.tooEarly", { count: scorecard.outcomes.too_early })} `}
              {scorecard.outcomes.unmeasured > 0 &&
                t("foot.unmeasured", { count: scorecard.outcomes.unmeasured })}
            </p>
          )}
          <WhyFold>
            <p>
              {t("foot.rate", {
                arithmetic: locale === "en" ? scorecard.arithmetic : rateArithmetic(scorecard, lw),
              })}
            </p>
            <p>{t("foot.append")}</p>
            <p>{t("foot.verdict")}</p>
          </WhyFold>
        </footer>
      </section>
    </main>
  );
}
