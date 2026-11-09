"use client";

// Insights · Seasons & bundles — ideas 46 and 48, on the sheet system
// (app/sheet.css). Two readings of the business's own measured history:
//
//   seasons  which weeks and months of the last year ran above and below
//            the normal week, and what the next eight weeks looked like
//            the same time last year — or, with under a year, how much
//            there is and what it can and can't say
//   bundles  what sold (or was booked) together more often than chance,
//            with the pair's margin where the owner's costs are known
//
// Read-only. "Propose this pair" drafts one proposal; nothing runs, no price
// changes and the checkout is never touched — the owner sets a pair up.
// Thresholds, windows, the method and that promise sit folded under "How I
// read it" / "How this works" (decluttered 2026-11-09, the owner's instruction).
//
// L-3b: the screen's own words are the "patterns" catalogue, the chart's
// "charts.season"; what lib/seasons and lib/bundles word (headlines, the
// season sentences, can/can't, notes) arrives in the reader's language
// from the server (L-4b, "patternsWords"). Item names are content.

import "../../app/patterns.css";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import type { PatternsView } from "../../app/api/patterns/route";
import type { BundleSource } from "../../lib/bundles/load";
import { shortDate } from "../../lib/charts/model";
import { monthYear } from "../../lib/i18n/format";
import { SeasonChart } from "../charts/SeasonChart";
import { Fold } from "../sheet/Fold";
import { PageHead, SheetCard } from "../sheet/PageHead";
import { num } from "../sheet/num";
import { useTr } from "../sheet/useTr";
import type { PatternWords } from "./patterns-view";
import {
  aheadRows,
  aheadTitle,
  headline,
  lineIn,
  longDate,
  marginText,
  proposalWord,
  ratioIn,
  seasonChartModel,
} from "./patterns-view";

/** How far back last year's week sits, so weekdays line up (lib/seasons). */
const WEEKS_BACK = 52;
/** The fewest measured days a month needs to be shown (lib/seasons). */
const MONTH_DAYS = 21;

function useWords(): PatternWords {
  const { tr, locale } = useTr("patterns");
  return { tr, locale };
}

function Frame({
  title,
  aside,
  children,
}: {
  title: ReactNode;
  aside?: ReactNode;
  children?: ReactNode;
}) {
  const { tr } = useWords();
  return (
    <main className="screen pt-screen">
      <PageHead kicker={tr("kicker")} title={title} aside={aside} />
      {children}
    </main>
  );
}

function Seasons({ view }: { view: PatternsView }) {
  const w = useWords();
  const { tr, locale } = w;
  const t = useTranslations("patterns");
  const chartWords = useTr("charts.season");
  const r = view.seasons.result;
  const chart = seasonChartModel(r, chartWords);
  if (r.status === "no_data") {
    return (
      <SheetCard title={tr("seasons.nothing")}>
        <p className="pt-copy">
          {t.rich("seasons.noData", {
            connect: view.seasons.connect,
            link: (c) => <Link href="/connections">{c}</Link>,
          })}
        </p>
      </SheetCard>
    );
  }
  if (r.status === "too_little") {
    return (
      <>
        {chart && <SeasonChart model={chart} />}
        <SheetCard
          label={tr("tooLittle.label", { source: r.series.source })}
          title={tr("tooLittle.title", {
            days: r.covered_days,
            from: shortDate(r.first_day, locale),
            to: shortDate(r.last_day, locale),
          })}
          meta={tr("tooLittle.meta", { have: r.complete_weeks, needed: r.needed_weeks })}
        >
          <p className="pt-copy">
            {tr("tooLittle.readyOn", { day: shortDate(r.ready_on, locale) })}
          </p>
          <Fold summary={tr("gap.label")}>
            <p className="pt-copy">{r.headline}</p>
            <p className="pt-sub">{tr("gap.can")}</p>
            <ul className="pt-list">
              {r.can.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
            <p className="pt-sub">{tr("gap.cannot")}</p>
            <ul className="pt-list">
              {r.cannot.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </Fold>
        </SheetCard>
      </>
    );
  }
  const rows = aheadRows(r, w);
  const others = view.seasons.other_currencies;
  return (
    <>
      {chart && <SeasonChart model={chart} />}
      <div className="pt-grid">
        <SheetCard
          label={tr("ahead.label", { count: rows.length })}
          title={r.upcoming.length === 0 ? tr("ahead.none") : aheadTitle(r.upcoming[0]!, w)}
        >
          {r.upcoming.map((u) => (
            <p className="pt-copy pt-strong" key={u.run.start}>
              {u.sentence}
            </p>
          ))}
          <table className="rt rt-stack pt-ahead">
            <thead>
              <tr>
                <th scope="col">{tr("col.thisYear")}</th>
                <th scope="col">{tr("col.lastYear")}</th>
                <th scope="col">{tr("col.flag")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.week}>
                  <th scope="row">{a.week}</th>
                  <td data-label={tr("col.lastYear")}>
                    {a.figure}
                    <span className="pt-src">{a.last_year}</span>
                  </td>
                  <td data-label={tr("col.flag")}>
                    {a.flag ? (
                      <span className={`flag ${a.flag === "busy" ? "ok" : "drift"}`}>
                        {tr(`flag.${a.flag}`)}
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </SheetCard>
        <SheetCard title={tr("months.title")}>
          <table className="rt rt-stack pt-months">
            <thead>
              <tr>
                <th scope="col">{tr("col.month")}</th>
                <th scope="col" className="num">
                  {tr("col.againstNormal")}
                </th>
              </tr>
            </thead>
            <tbody>
              {r.months.map((m) => (
                <tr key={m.month}>
                  <th scope="row">
                    {locale === "en" ? m.label : monthYear(`${m.month}-01`, locale)}
                  </th>
                  <td className="num" data-label={tr("col.againstNormal")}>
                    {ratioIn(m, locale)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </SheetCard>
      </div>
      <Fold summary={tr("read.label")}>
        <ul className="pt-list">
          <li>{tr("ahead.meta", { weeks: WEEKS_BACK })}</li>
          <li>{tr("months.meta", { days: MONTH_DAYS })}</li>
          {r.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
          {others.length > 0 && (
            <li>
              {tr("read.otherCurrencies", { noun: r.series.noun, currencies: others.join(", ") })}
            </li>
          )}
        </ul>
      </Fold>
    </>
  );
}

function Pairs({
  source,
  view,
  onPropose,
  busyKey,
}: {
  source: BundleSource;
  view: PatternsView;
  onPropose: (key: string) => void;
  busyKey: string | null;
}) {
  const w = useWords();
  const { tr, locale } = w;
  const kind = source.kind === "orders" ? "orders" : "visits";
  const amount = (count: number) => tr(`count.${kind}`, { count });
  const units = tr(`unit.${kind}`);
  const t = view.bundles.thresholds;
  const r = source.result;
  const label = tr("pairs.label", { kind, source: source.label });
  if (r.status === "too_few") {
    return (
      <SheetCard label={label} title={tr("pairs.tooFew", { amount: amount(r.baskets) })}>
        <Fold summary={tr("why")}>
          <p className="pt-copy">{tr("pairs.tooFewBody", { amount: amount(r.needed) })}</p>
        </Fold>
      </SheetCard>
    );
  }
  const rule = tr("pairs.footRule", {
    amount: amount(t.min_together),
    lift: lineIn(t.min_lift, locale),
  });
  const below =
    source.ungrouped > 0
      ? tr("pairs.footBelowUngrouped", {
          below: r.below_count,
          belowLift: r.below_lift,
          ungrouped: source.ungrouped,
        })
      : tr("pairs.footBelow", { below: r.below_count, belowLift: r.below_lift });
  return (
    <SheetCard
      label={label}
      title={
        source.pairs.length === 0
          ? tr("pairs.none")
          : tr("pairs.some", { count: source.pairs.length })
      }
      foot={
        <Fold summary={tr("how")}>
          <p>
            {tr("pairs.meta", {
              amount: amount(r.baskets),
              from: longDate(source.from, locale),
              to: longDate(source.to, locale),
            })}
          </p>
          <p>{`${rule} ${below}`}</p>
        </Fold>
      }
    >
      {source.pairs.length === 0 ? (
        <p className="pt-copy">
          {r.multi === 0
            ? tr("pairs.single", { kind })
            : tr("pairs.multi", { multi: r.multi, units })}
        </p>
      ) : (
        <div className="pt-table-wrap" tabIndex={0} aria-label={tr("pairs.aria")}>
          <table className="rt rt-stack pt-pairs">
            <thead>
              <tr>
                <th scope="col">{tr("col.pair")}</th>
                <th scope="col" className="num">
                  {tr("col.together")}
                </th>
                <th scope="col">{tr("col.alsoSecond")}</th>
                <th scope="col" className="num">
                  {tr("col.againstChance")}
                </th>
                <th scope="col">{tr("col.margin")}</th>
                <th scope="col">{tr("col.proposal")}</th>
              </tr>
            </thead>
            <tbody>
              {source.pairs.map((p) => {
                const word = proposalWord(view.proposed[p.key], tr);
                return (
                  <tr key={p.key}>
                    <th scope="row">
                      {p.a_name} + {p.b_name}
                    </th>
                    <td className="num" data-label={tr("col.together")}>
                      {amount(p.together)}
                    </td>
                    <td data-label={tr("col.alsoSecond")}>
                      {tr("pairs.share", {
                        pct: Math.round(p.confidence * 100),
                        units,
                        a: p.a_name,
                      })}
                      <span className="pt-src">
                        {tr("pairs.had", { amount: amount(p.count_a), a: p.a_name })}
                      </span>
                    </td>
                    <td className="num" data-label={tr("col.againstChance")}>
                      {num(Math.round(p.lift * 10) / 10, 1, locale)}×
                      <span className="pt-src">
                        {tr("pairs.byChance", { count: Math.round(p.expected) })}
                      </span>
                    </td>
                    <td data-label={tr("col.margin")}>{marginText(p.margin, w)}</td>
                    <td data-label={tr("col.proposal")}>
                      {word ? (
                        <span className={`word ${word.tone}`}>{word.word}</span>
                      ) : (
                        <button
                          type="button"
                          className="act"
                          disabled={view.held !== null || busyKey !== null}
                          onClick={() => onPropose(p.key)}
                        >
                          {busyKey === p.key ? tr("pairs.drafting") : tr("pairs.propose")}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </SheetCard>
  );
}

export function PatternsScreen() {
  const w = useWords();
  const { tr, locale } = w;
  const t = useTranslations("patterns");
  const [view, setView] = useState<PatternsView | null>(null);
  const [failed, setFailed] = useState<"signed_out" | "error" | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/patterns", { cache: "no-store" });
      if (res.status === 401) return setFailed("signed_out");
      if (!res.ok) return setFailed("error");
      setView((await res.json()) as PatternsView);
    } catch {
      setFailed("error");
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const propose = async (key: string) => {
    setBusyKey(key);
    setNote(null);
    try {
      const res = await fetch("/api/patterns", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "propose", key }),
      });
      const body = (await res.json()) as { status?: string; error?: string };
      if (!res.ok) setNote(body.error ?? tr("note.failed"));
      else {
        setNote(body.status === "blocked" ? tr("note.blocked") : tr("note.drafted"));
        await load();
      }
    } catch {
      setNote(tr("note.ourSide"));
    } finally {
      setBusyKey(null);
    }
  };

  if (failed === "signed_out") {
    return (
      <Frame title={tr("signedOut.title")}>
        <p className="pt-wait">
          {t.rich("signedOut.body", { link: (c) => <Link href="/intake">{c}</Link> })}
        </p>
      </Frame>
    );
  }
  if (failed) {
    return (
      <Frame title={tr("error.title")}>
        <p className="pt-wait">{tr("error.body")}</p>
      </Frame>
    );
  }
  if (!view) return <Frame title={tr("loading")} />;

  const r = view.seasons.result;
  const aside =
    r.status === "no_data"
      ? tr("aside.none")
      : tr("aside.span", {
          source: r.series.source,
          from: longDate(r.first_day, locale),
          to: longDate(r.last_day, locale),
        });
  const sources = view.bundles.sources;

  return (
    <Frame title={headline(view, w)} aside={aside}>
      <Seasons view={view} />
      <h2 className="pt-section">{tr("bundles.section")}</h2>
      {sources.length === 0 ? (
        <SheetCard title={tr("bundles.emptyTitle")}>
          <p className="pt-copy">
            {tr("bundles.emptyBody")}
            {view.bundles.without_lines.length > 0 &&
              ` ${tr("bundles.withoutLines", { names: view.bundles.without_lines.join(", ") })}`}{" "}
            <Link href="/connections">{tr("connections")}</Link>
          </p>
        </SheetCard>
      ) : (
        sources.map((s) => (
          <Pairs
            key={s.connection_id + s.kind}
            source={s}
            view={view}
            onPropose={(k) => void propose(k)}
            busyKey={busyKey}
          />
        ))
      )}
      {sources.some((s) => s.pairs.length > 0) && (
        <>
          {(view.held || note) && (
            <p className="pt-copy pt-held">
              {view.held && `${view.held} `}
              {note && (
                <>
                  {note} <Link href="/proposals">{tr("waiting")}</Link>
                </>
              )}
            </p>
          )}
          <Fold summary={tr("how")}>
            <p className="pt-copy pt-held">{tr("held")}</p>
          </Fold>
        </>
      )}
    </Frame>
  );
}
