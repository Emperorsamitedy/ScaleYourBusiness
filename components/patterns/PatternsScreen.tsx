"use client";

// Insights · Seasons & bundles — ideas 46 and 48, on the sheet system
// (app/sheet.css). Two readings of the business's own measured history:
//
//   seasons  which weeks and months of the last year ran above and below
//            the normal week, and what the next eight weeks looked like
//            the same time last year — or, with under a year, how much
//            there is and what it can and can't say
//   bundles  what sold (or was booked) together more often than chance,
//            with the pair's price and what is left after costs
//
// Said plainly on 2026-11-28 (the canvas design the owner approved, after
// "make it look more natural, what a senior UX designer would make"): the
// title names the stretch ahead; the year is one chart labelled on its own
// bars, with what's coming up and the same weeks last year beneath it; the
// months are one shaded strip; the pairs are a plain table. Distances from
// normal are percentages. The ranges, the rules and the method sit in one
// fold at the foot, "How Lex worked this out". The figures and the rules
// that decide busy, quiet and a pair are unchanged.
//
// Read-only. "Suggest as a bundle" drafts one proposal; nothing runs, no
// price changes and the checkout is never touched — the owner sets a pair up.
//
// L-3b: the screen's own words are the "patterns" catalogue; what
// lib/seasons and lib/bundles word (the season sentences, can/can't, notes)
// arrives in the reader's language from the server (L-4b,
// "patternsWords"). Item names are content.

import "../../app/patterns.css";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import type { PatternsView } from "../../app/api/patterns/route";
import type { BundleSource } from "../../lib/bundles/load";
import { shortDate } from "../../lib/charts/model";
import type { SeasonResult } from "../../lib/seasons/forecast";
import { SeasonChart } from "../charts/SeasonChart";
import { Fold } from "../sheet/Fold";
import { PageHead, SheetCard } from "../sheet/PageHead";
import { num } from "../sheet/num";
import { useTr } from "../sheet/useTr";
import type { PatternWords } from "./patterns-view";
import {
  aheadRows,
  capitalFirst,
  headline,
  lineIn,
  longDate,
  monthTone,
  pairMoney,
  proposalWord,
  seasonChartModel,
  signedPct,
  sizePct,
  titleOf,
  weekValue,
} from "./patterns-view";
import { YearChart } from "./YearChart";

type Ready = Extract<SeasonResult, { status: "ready" }>;

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
  lede,
  children,
}: {
  title: ReactNode;
  lede?: ReactNode;
  children?: ReactNode;
}) {
  const { tr } = useWords();
  return (
    <main className="screen pt-screen">
      <PageHead kicker={tr("kicker")} title={title}>
        {lede && <p className="pt-lede">{lede}</p>}
      </PageHead>
      {children}
    </main>
  );
}

/** The title and the line under it, from the first stretch ahead and the one after it. */
function readyHead(r: Ready, { tr, locale }: PatternWords): { title: string; lede: string } {
  const t = titleOf(r);
  const title = tr(t.key, t);
  const money = r.series.currency ? "yes" : "no";
  const first = r.upcoming[0];
  if (!first) return { title, lede: "" };
  const lines = [
    tr("lede.first", {
      count: first.run.weeks,
      money,
      total: weekValue(first.run.total, r.series.currency, r.series.noun, locale),
      pct: sizePct(first.run.index, locale),
      kind: first.run.kind,
    }),
  ];
  const next = r.upcoming.find((u) => u.run.kind !== first.run.kind);
  if (next) {
    lines.push(tr("lede.then", { kind: next.run.kind, day: shortDate(next.run.start, locale) }));
  }
  return { title, lede: lines.join(" ") };
}

function YearCard({ r }: { r: Ready }) {
  const { tr, locale } = useWords();
  const money = r.series.currency;
  const value = (v: number) => weekValue(v, money, r.series.noun, locale);
  const rows = aheadRows(r, locale);
  const valueCol = money ? tr("weeks.colSales") : capitalFirst(r.series.noun);
  return (
    <SheetCard
      className="pt-card"
      title={money ? tr("year.titleSales") : tr("year.title", { noun: r.series.noun })}
    >
      <p className="pt-src">
        {tr("year.src", {
          count: r.weeks.length,
          source: r.series.source,
          normal: value(r.normal.median),
        })}
      </p>
      <YearChart r={r} />
      <div className="pt-split">
        <div>
          <h3 className="pt-label">{tr("coming.label")}</h3>
          {r.upcoming.length === 0 ? (
            <p className="pt-copy">{tr("coming.none", { count: r.ahead.length })}</p>
          ) : (
            <ul className="pt-coming">
              {r.upcoming.map((u) => (
                <li key={u.run.start} className={`pt-coming-${u.run.kind}`}>
                  <p className="pt-when">
                    {u.in_progress
                      ? tr("coming.now", { day: shortDate(u.ends_on, locale) })
                      : tr("coming.span", {
                          from: shortDate(u.starts_on, locale),
                          to: shortDate(u.ends_on, locale),
                        })}
                  </p>
                  <p>
                    {tr("coming.body", {
                      kind: u.run.kind,
                      count: u.run.weeks,
                      money: money ? "yes" : "no",
                      total: value(u.run.total),
                      pct: sizePct(u.run.index, locale),
                    })}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <h3 className="pt-label">{tr("weeks.label")}</h3>
          <table className="pt-weeks">
            <thead>
              <tr>
                <th scope="col">{tr("weeks.colWeek")}</th>
                <th scope="col" className="num">
                  {valueCol}
                </th>
                <th scope="col" className="num">
                  {tr("weeks.colAgainst")}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.start}>
                  <th scope="row">{shortDate(a.start, locale)}</th>
                  {a.value === null ? (
                    <td colSpan={2} className="pt-muted">
                      {tr("weeks.notMeasured")}
                    </td>
                  ) : (
                    <>
                      <td className="num">{a.value}</td>
                      <td className={a.flag ? `num pt-${a.flag}-fig` : "num"}>
                        {a.pct}
                        {a.flag && <span className="sr-only"> {tr(`chart.kind.${a.flag}`)}</span>}
                      </td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </SheetCard>
  );
}

function MonthsCard({ r }: { r: Ready }) {
  const { tr, locale } = useWords();
  if (r.months.length === 0) return null;
  const name = (month: string, k: number) => {
    const d = new Date(`${month}-01T00:00:00Z`);
    const withYear = k === 0 || d.getUTCMonth() === 0;
    return new Intl.DateTimeFormat(locale, {
      month: "short",
      ...(withYear ? { year: "2-digit" } : {}),
      timeZone: "UTC",
    }).format(d);
  };
  return (
    <SheetCard className="pt-card" title={tr("months.title")}>
      <p className="pt-src">
        {tr("months.src", { money: r.series.currency ? "yes" : "no", noun: r.series.noun })}
      </p>
      <ol className="pt-strip">
        {r.months.map((m, k) => (
          <li key={m.month} className={`pt-m pt-m-${monthTone(m.index)}`}>
            <span>{name(m.month, k)}</span>
            <b>{signedPct(m.index, locale)}</b>
          </li>
        ))}
      </ol>
    </SheetCard>
  );
}

/** Seasons before a year is measured: how much there is, or that nothing is. */
function EarlySeasons({ view }: { view: PatternsView }) {
  const w = useWords();
  const { tr, locale } = w;
  const t = useTranslations("patterns");
  const chartWords = useTr("charts.season");
  const r = view.seasons.result;
  if (r.status === "no_data") {
    return (
      <SheetCard className="pt-card" title={tr("seasons.nothing")}>
        <p className="pt-copy">
          {t.rich("seasons.noData", {
            connect: view.seasons.connect,
            link: (c) => <Link href="/connections">{c}</Link>,
          })}
        </p>
      </SheetCard>
    );
  }
  if (r.status !== "too_little") return null;
  const chart = seasonChartModel(r, chartWords);
  return (
    <>
      {chart && <SeasonChart model={chart} />}
      <SheetCard
        className="pt-card"
        label={tr("tooLittle.label", { source: r.series.source })}
        title={tr("tooLittle.title", {
          days: r.covered_days,
          from: shortDate(r.first_day, locale),
          to: shortDate(r.last_day, locale),
        })}
        meta={tr("tooLittle.meta", { have: r.complete_weeks, needed: r.needed_weeks })}
      >
        <p className="pt-copy">{tr("tooLittle.readyOn", { day: shortDate(r.ready_on, locale) })}</p>
        <Fold summary={tr("gap.label")}>
          <p className="pt-copy">{r.headline}</p>
          <p className="pt-label">{tr("gap.can")}</p>
          <ul className="pt-list">
            {r.can.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
          <p className="pt-label">{tr("gap.cannot")}</p>
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
  const t = useTranslations("patterns");
  const kind = source.kind === "orders" ? "orders" : "visits";
  const amount = (count: number) => tr(`count.${kind}`, { count });
  const units = tr(`unit.${kind}`);
  const r = source.result;
  const title = tr("pairs.title", { kind });
  if (r.status === "too_few") {
    return (
      <SheetCard className="pt-card" title={title}>
        <p className="pt-copy">
          {tr("pairs.tooFew", { amount: amount(r.baskets) })}{" "}
          {tr("pairs.tooFewBody", { amount: amount(r.needed) })}
        </p>
      </SheetCard>
    );
  }
  const n = (v: number) => num(v, 0, locale);
  return (
    <SheetCard className="pt-card" title={title}>
      <p className="pt-src">
        {source.pairs.length === 0
          ? tr("pairs.srcNone", { amount: amount(r.baskets), source: source.label })
          : tr("pairs.src", {
              amount: amount(r.baskets),
              source: source.label,
              count: source.pairs.length,
            })}
      </p>
      {source.pairs.length === 0 ? (
        <p className="pt-copy">
          {r.multi === 0
            ? tr("pairs.single", { kind })
            : tr("pairs.multi", { multi: r.multi, units })}
        </p>
      ) : (
        <table className="pt-pairs">
          <thead>
            <tr>
              <th scope="col">{tr("pairs.colPair")}</th>
              <th scope="col" className="num">
                {tr("pairs.colTogether", { kind })}
              </th>
              <th scope="col" className="num">
                {tr("pairs.colChance")}
              </th>
              <th scope="col" className="num">
                {tr("pairs.colPrice")}
              </th>
              <th scope="col" className="num">
                {tr("pairs.colLeft")}
              </th>
              <th scope="col">
                <span className="sr-only">{tr("pairs.colAction")}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {source.pairs.map((p) => {
              const word = proposalWord(view.proposed[p.key], tr);
              const m = pairMoney(p.margin, w);
              return (
                <tr key={p.key}>
                  <th scope="row">
                    <span className="pt-pair-name">
                      {t.rich("pairs.name", {
                        a: p.a_name,
                        b: p.b_name,
                        m: (c) => <span className="pt-with">{c}</span>,
                      })}
                    </span>
                    <span className="pt-pair-line">
                      {tr("pairs.line", {
                        pct: Math.round(p.confidence * 100),
                        units,
                        a: p.a_name,
                        b: p.b_name,
                      })}
                    </span>
                    {!m.known && <span className="pt-pair-line">{m.why}</span>}
                  </th>
                  <td className="num" data-label={tr("pairs.colTogether", { kind })}>
                    <span className="pt-fig">
                      {n(p.together)}
                      <span className="pt-fig-sub">{tr("pairs.of", { count: p.count_a })}</span>
                    </span>
                  </td>
                  <td className="num" data-label={tr("pairs.colChance")}>
                    {n(Math.round(p.expected))}
                  </td>
                  <td className="num" data-label={tr("pairs.colPrice")}>
                    {m.known ? m.price : tr("pairs.unknown")}
                  </td>
                  <td className="num" data-label={tr("pairs.colLeft")}>
                    {m.known ? (
                      <span className="pt-fig">
                        {m.left}
                        <span className="pt-fig-sub">{m.pct}</span>
                      </span>
                    ) : (
                      tr("pairs.unknown")
                    )}
                  </td>
                  <td className="pt-act">
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
      )}
    </SheetCard>
  );
}

/** Everything the page leaves out to stay plain: the ranges, the rules and the method. */
function HowFold({ view }: { view: PatternsView }) {
  const { tr, locale } = useWords();
  const r = view.seasons.result;
  const others = view.seasons.other_currencies;
  const th = view.bundles.thresholds;
  const mined = view.bundles.sources.filter(
    (s): s is BundleSource & { result: Extract<BundleSource["result"], { status: "mined" }> } =>
      s.result.status === "mined",
  );
  const anyPairs = view.bundles.sources.some((s) => s.pairs.length > 0);
  if (r.status !== "ready" && mined.length === 0) return null;
  return (
    <Fold className="pt-how" summary={tr("read.label")}>
      <ul className="pt-list">
        {r.status === "ready" && (
          <>
            {r.upcoming.map((u) => (
              <li key={u.run.start}>{u.sentence}</li>
            ))}
            <li>{tr("ahead.meta", { weeks: WEEKS_BACK })}</li>
            <li>{tr("months.meta", { days: MONTH_DAYS })}</li>
            {r.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
            {others.length > 0 && (
              <li>
                {tr("read.otherCurrencies", {
                  noun: r.series.noun,
                  currencies: others.join(", "),
                })}
              </li>
            )}
          </>
        )}
        {mined.map((s) => {
          const kind = s.kind === "orders" ? "orders" : "visits";
          const amount = (count: number) => tr(`count.${kind}`, { count });
          const below =
            s.ungrouped > 0
              ? tr("pairs.footBelowUngrouped", {
                  below: s.result.below_count,
                  belowLift: s.result.below_lift,
                  ungrouped: s.ungrouped,
                })
              : tr("pairs.footBelow", {
                  below: s.result.below_count,
                  belowLift: s.result.below_lift,
                });
          return (
            <li key={s.connection_id + s.kind}>
              {tr("pairs.meta", {
                amount: amount(s.result.baskets),
                source: s.label,
                from: longDate(s.from, locale),
                to: longDate(s.to, locale),
              })}{" "}
              {tr("pairs.footRule", {
                amount: amount(th.min_together),
                lift: lineIn(th.min_lift, locale),
              })}{" "}
              {below}
            </li>
          );
        })}
        {anyPairs && <li>{tr("held")}</li>}
      </ul>
    </Fold>
  );
}

export function PatternsScreen() {
  const w = useWords();
  const { tr } = w;
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
  const head = r.status === "ready" ? readyHead(r, w) : { title: headline(view, w), lede: "" };
  const sources = view.bundles.sources;
  const anyPairs = sources.some((s) => s.pairs.length > 0);

  return (
    <Frame title={head.title} lede={head.lede || undefined}>
      {r.status === "ready" ? (
        <>
          <YearCard r={r} />
          <MonthsCard r={r} />
        </>
      ) : (
        <EarlySeasons view={view} />
      )}
      {sources.length === 0 ? (
        <SheetCard className="pt-card" title={tr("bundles.emptyTitle")}>
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
      {anyPairs && (
        <p className="pt-foot">
          {view.held && `${view.held} `}
          {tr("pairs.foot")}
          {note && (
            <>
              {" "}
              {note} <Link href="/proposals">{tr("waiting")}</Link>
            </>
          )}
        </p>
      )}
      <HowFold view={view} />
    </Frame>
  );
}
