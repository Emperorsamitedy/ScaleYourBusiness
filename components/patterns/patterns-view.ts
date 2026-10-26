// Pure helpers for Insights · Seasons & bundles (ideas 46 and 48): the
// words and the chart model the screen draws from GET /api/patterns.
// No React, no fetch — tested in patterns-view.test.ts.

import type { PatternsView } from "../../app/api/patterns/route";
import type { PairMargin } from "../../lib/bundles/pairs";
import { dayMoney, shortDate } from "../../lib/charts/model";
import type { SeasonResult } from "../../lib/seasons/forecast";
import { SEASONS, ratioText } from "../../lib/seasons/forecast";
import type { SeasonChartModel } from "../charts/SeasonChart";

type Ready = Extract<SeasonResult, { status: "ready" }>;
type TooLittle = Extract<SeasonResult, { status: "too_little" }>;

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The page's one display line: the season's main fact, else the pairs', else what's missing. */
export function headline(view: PatternsView): string {
  const r = view.seasons.result;
  if (r.status === "ready") return r.headline;
  const pairs = view.bundles.sources.flatMap((s) => s.pairs);
  if (pairs.length > 0) {
    const p = pairs[0]!;
    return `${p.a_name} and ${p.b_name} go together ${(Math.round(p.lift * 10) / 10).toFixed(1)}× as often as chance.`;
  }
  if (r.status === "too_little") return r.headline;
  return "Nothing measured yet to find your seasons in.";
}

export function seasonChartModel(r: SeasonResult): SeasonChartModel | null {
  if (r.status === "ready") return readyChart(r);
  if (r.status === "too_little") return tooLittleChart(r);
  return null;
}

function readyChart(r: Ready): SeasonChartModel {
  const ahead = new Set(r.ahead.map((a) => a.last_year_start));
  const busy = r.weeks.filter((w) => w.flag === "busy").length;
  const quiet = r.weeks.filter((w) => w.flag === "quiet").length;
  return {
    label: `Your year · ${r.weeks.length} weeks`,
    title:
      busy + quiet === 0
        ? "Every week of the last year near your normal week"
        : `${busy} busy and ${quiet} quiet week${quiet === 1 ? "" : "s"} in the last year`,
    meta: `${capital(r.series.source)} · ${r.series.noun} · OBSERVED weeks, DERIVED index`,
    foot: `Each bar is one week's ${r.series.noun} ÷ your normal week (the median of the last ${SEASONS.year_weeks}). Busy is ${SEASONS.busy_index}× or more, quiet ${SEASONS.quiet_index}× or less.`,
    summary: `${r.weeks.length} weeks of ${r.series.noun} against your normal week; ${busy} busy, ${quiet} quiet. ${r.headline}`,
    weeks: r.weeks.map((w) => ({
      start: w.start,
      value: w.value,
      index: w.index,
      low: w.low,
      high: w.high,
      flag: w.flag,
      ahead: ahead.has(w.start),
    })),
    band: {
      low: r.normal.p25 / r.normal.median,
      high: r.normal.p75 / r.normal.median,
    },
    lines: { busy: SEASONS.busy_index, quiet: SEASONS.quiet_index },
    currency: r.series.currency,
    noun: r.series.noun,
  };
}

function tooLittleChart(r: TooLittle): SeasonChartModel | null {
  const med = r.recent_median;
  if (r.recent.length < 2 || med === null || med <= 0) return null;
  return {
    label: `The weeks there are · ${r.recent.length}`,
    title: "Your weeks against each other — not a season yet",
    meta: `${capital(r.series.source)} · ${r.series.noun} · OBSERVED`,
    foot: `Against your median week of these ${r.recent.length}. A season needs ${r.needed_weeks} complete weeks of the last ${SEASONS.year_weeks}; you have ${r.complete_weeks}.`,
    summary: `${r.recent.length} complete weeks of ${r.series.noun}, against their own median. Not enough history to name a season.`,
    weeks: r.recent.map((w) => ({
      start: w.start,
      value: w.value,
      index: w.value / med,
      low: null,
      high: null,
      flag: null,
      ahead: false,
    })),
    band: null,
    lines: null,
    currency: r.series.currency,
    noun: r.series.noun,
  };
}

/** "€1,240" for money, "312 orders" for a count. */
export function weekValue(value: number, currency: string | null, noun: string): string {
  return currency ? dayMoney(value, currency) : `${Math.round(value)} ${noun}`;
}

export interface AheadRow {
  week: string;
  last_year: string;
  figure: string;
  flag: "busy" | "quiet" | null;
}

/** The next eight weeks, each beside the same week last year. */
export function aheadRows(r: Ready): AheadRow[] {
  return r.ahead.map((a) => ({
    week: `Week of ${shortDate(a.start)}`,
    last_year: `Week of ${shortDate(a.last_year_start)} last year`,
    figure: a.last_year
      ? `${weekValue(a.last_year.value, r.series.currency, r.series.noun)} · ${ratioText(a.last_year)}`
      : "not measured in full last year",
    flag: a.flag,
  }));
}

export function marginText(m: PairMargin): string {
  if (!m.known) return `Margin unknown: ${m.why}.`;
  return `${dayMoney(m.price_minor, m.currency)} for the pair, ${dayMoney(m.contribution_minor, m.currency)} after costs (${m.margin_pct}%).`;
}

export function proposalWord(
  p: { status: string } | undefined,
): { word: string; tone: string } | null {
  if (!p) return null;
  switch (p.status) {
    case "pending":
      return { word: "Waiting for you", tone: "ok" };
    case "blocked":
      return { word: "Blocked by your rule", tone: "alarm" };
    case "approved":
      return { word: "Approved", tone: "ok" };
    case "rejected":
      return { word: "Declined", tone: "none" };
    case "expired":
      return { word: "Expired", tone: "none" };
    default:
      return { word: p.status.replace(/_/g, " "), tone: "none" };
  }
}
