// Pure helpers for Insights · Seasons & bundles (ideas 46 and 48): the
// words and the chart model the screen draws from GET /api/patterns.
// No React, no fetch — tested in patterns-view.test.ts.
//
// L-3b: the fixed words are the "patterns" catalogue (and the season
// chart's, "charts.season") through an optional translator, English by
// default; figures and dates in the reader's locale, money in the
// business's currency. L-4b: what lib/seasons and lib/bundles word (the
// season headline and sentences, the series noun and source, a margin's
// why) comes from the server already in the reader's language
// ("patternsWords", app/api/patterns).
//
// Said plainly on 2026-11-28 (the canvas design the owner approved): how
// far a week sat from normal is a percentage ("+91%"), not a multiple; the
// title names the stretch ahead; months are one shaded strip.

import type { AppLocale } from "../../lib/i18n/locales";
import { intlTag } from "../../lib/i18n/locales";
import { dayMonthYear } from "../../lib/i18n/format";
import type { Tr } from "../../lib/i18n/tr";
import { englishTr } from "../../lib/i18n/tr";
import type { PatternsView } from "../../app/api/patterns/route";
import type { PairMargin } from "../../lib/bundles/pairs";
import { minorUnitExponent } from "../../lib/core/money";
import { dayMoney, shortDate } from "../../lib/charts/model";
import type { SeasonResult } from "../../lib/seasons/forecast";
import { SEASONS, multipleIn } from "../../lib/seasons/forecast";
import type { SeasonChartModel } from "../charts/SeasonChart";
import { moneyText, num } from "../sheet/num";

type Ready = Extract<SeasonResult, { status: "ready" }>;
type TooLittle = Extract<SeasonResult, { status: "too_little" }>;

/** The screen's words and the reader's locale: the "patterns" catalogue. */
export interface PatternWords {
  tr: Tr;
  locale: AppLocale;
}
const ENGLISH = (): PatternWords => ({ tr: englishTr("patterns"), locale: "en" });

/** "revenue" to "Revenue": a word the server sends, starting a heading. */
export const capitalFirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const capital = capitalFirst;

/** A multiple to one decimal: "2.0×". */
export function timesIn(x: number, locale: AppLocale = "en"): string {
  return `${num(Math.round(x * 10) / 10, 1, locale)}×`;
}

/** A plain multiple as the code states it ("1.25×", "0.8×"), in the reader's digits. */
export function lineIn(x: number, locale: AppLocale = "en"): string {
  return multipleIn(x, locale);
}

/** A chart figure in whole major units of the business's currency (lib/charts' dayMoney). */
export function dayMoneyIn(minor: number, currency: string, locale: AppLocale = "en"): string {
  if (locale === "en") return dayMoney(minor, currency);
  const unit = 10 ** minorUnitExponent(currency);
  return moneyText(Math.round(minor / unit) * unit, currency, locale);
}

/** The page's one display line: the season's main fact, else the pairs', else what's missing. */
export function headline(view: PatternsView, w: PatternWords = ENGLISH()): string {
  const r = view.seasons.result;
  if (r.status === "ready") return r.headline;
  const pairs = view.bundles.sources.flatMap((s) => s.pairs);
  if (pairs.length > 0) {
    const p = pairs[0]!;
    return w.tr("head.pair", {
      a: p.a_name,
      b: p.b_name,
      lift: num(Math.round(p.lift * 10) / 10, 1, w.locale),
    });
  }
  if (r.status === "too_little") return r.headline;
  return w.tr("head.nothing");
}

export function seasonChartModel(
  r: SeasonResult,
  w: PatternWords = { tr: englishTr("charts.season"), locale: "en" },
): SeasonChartModel | null {
  if (r.status === "ready") return readyChart(r, w);
  if (r.status === "too_little") return tooLittleChart(r, w);
  return null;
}

function readyChart(r: Ready, { tr, locale }: PatternWords): SeasonChartModel {
  const ahead = new Set(r.ahead.map((a) => a.last_year_start));
  const busy = r.weeks.filter((w) => w.flag === "busy").length;
  const quiet = r.weeks.filter((w) => w.flag === "quiet").length;
  const noun = r.series.noun;
  return {
    label: tr("ready.label", { count: r.weeks.length }),
    title: busy + quiet === 0 ? tr("ready.titleEven") : tr("ready.title", { busy, quiet }),
    meta: tr("ready.meta", { source: capital(r.series.source), noun }),
    foot: tr("ready.foot", {
      noun,
      weeks: SEASONS.year_weeks,
      busy: lineIn(SEASONS.busy_index, locale),
      quiet: lineIn(SEASONS.quiet_index, locale),
    }),
    summary: tr("ready.summary", {
      count: r.weeks.length,
      noun,
      busy,
      quiet,
      headline: r.headline,
    }),
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
    noun,
  };
}

function tooLittleChart(r: TooLittle, { tr }: PatternWords): SeasonChartModel | null {
  const med = r.recent_median;
  if (r.recent.length < 2 || med === null || med <= 0) return null;
  const noun = r.series.noun;
  return {
    label: tr("short.label", { count: r.recent.length }),
    title: tr("short.title"),
    meta: tr("short.meta", { source: capital(r.series.source), noun }),
    foot: tr("short.foot", {
      count: r.recent.length,
      needed: r.needed_weeks,
      weeks: SEASONS.year_weeks,
      have: r.complete_weeks,
    }),
    summary: tr("short.summary", { count: r.recent.length, noun }),
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
    noun,
  };
}

/** "€1,240" for money, "312 orders" for a count. */
export function weekValue(
  value: number,
  currency: string | null,
  noun: string,
  locale: AppLocale = "en",
): string {
  return currency
    ? dayMoneyIn(value, currency, locale)
    : `${num(Math.round(value), 0, locale)} ${noun}`;
}

/** How far a week sat from its normal, signed: "+91%", "-28%", "0%" in the reader's locale. */
export function signedPct(index: number, locale: AppLocale = "en"): string {
  return new Intl.NumberFormat(intlTag(locale), {
    style: "percent",
    signDisplay: "exceptZero",
    maximumFractionDigits: 0,
  }).format(Math.round((index - 1) * 100) / 100);
}

/** The same distance without its sign ("91%"), for a sentence that says above or below. */
export function sizePct(index: number, locale: AppLocale = "en"): string {
  return new Intl.NumberFormat(intlTag(locale), {
    style: "percent",
    maximumFractionDigits: 0,
  }).format(Math.abs(Math.round((index - 1) * 100)) / 100);
}

export interface AheadRow {
  /** The week this year, as its first day. */
  start: string;
  /** Last year's figure for the same week; null when it wasn't measured in full. */
  value: string | null;
  /** Last year's distance from normal, signed; null when not measured. */
  pct: string | null;
  flag: "busy" | "quiet" | null;
}

/** The next eight weeks, each with the same week last year. */
export function aheadRows(r: Ready, locale: AppLocale = "en"): AheadRow[] {
  return r.ahead.map((a) => ({
    start: a.start,
    value: a.last_year
      ? weekValue(a.last_year.value, r.series.currency, r.series.noun, locale)
      : null,
    pct: a.last_year ? signedPct(a.last_year.index, locale) : null,
    flag: a.flag,
  }));
}

/** A month's shade in the strip: busy and quiet by the season's own lines, a nudge either way between. */
export type MonthTone = "busy" | "up" | "even" | "down" | "quiet";
export function monthTone(index: number): MonthTone {
  if (index >= SEASONS.busy_index) return "busy";
  if (index <= SEASONS.quiet_index) return "quiet";
  if (index >= 1.1) return "up";
  if (index <= 0.9) return "down";
  return "even";
}

/** The page title's message: the first stretch ahead, or that none is coming. */
export function titleOf(r: Ready):
  | { key: "title.underWay" | "title.thisWeek"; kind: "busy" | "quiet" }
  | {
      key: "title.startsIn";
      kind: "busy" | "quiet";
      count: number;
    }
  | { key: "title.even"; count: number } {
  const u = r.upcoming[0];
  if (!u) return { key: "title.even", count: r.ahead.length };
  if (u.in_progress) return { key: "title.underWay", kind: u.run.kind };
  if (u.starts_in_weeks === 0) return { key: "title.thisWeek", kind: u.run.kind };
  return { key: "title.startsIn", kind: u.run.kind, count: u.starts_in_weeks };
}

/**
 * The stretch this year's latest weeks are in: its kind and its first week,
 * counted back while the weeks keep that flag. Null when the latest week is
 * neither busy nor quiet, or the stretch is a single week (a one-off, by the
 * season's own rule).
 */
export function currentRun(
  weeks: readonly { start: string; flag: "busy" | "quiet" | null }[],
): { kind: "busy" | "quiet"; start: string; weeks: number } | null {
  const last = weeks.at(-1);
  if (!last?.flag) return null;
  let i = weeks.length - 1;
  while (i > 0 && weeks[i - 1]!.flag === last.flag) i--;
  const count = weeks.length - i;
  if (count < SEASONS.min_run_weeks) return null;
  return { kind: last.flag, start: weeks[i]!.start, weeks: count };
}

/** "4 Oct 2025": the aside spans years, so it names them; in another language, its own (L-1). */
export function longDate(day: string, locale: AppLocale = "en"): string {
  if (locale !== "en") return dayMonthYear(day, locale);
  return `${shortDate(day)} ${day.slice(0, 4)}`;
}

/** A pair's price, what is left after costs and that share, or why it isn't known. */
export function pairMoney(
  m: PairMargin,
  w: PatternWords = ENGLISH(),
): { known: true; price: string; left: string; pct: string } | { known: false; why: string } {
  if (!m.known) return { known: false, why: w.tr("margin.unknown", { why: m.why }) };
  return {
    known: true,
    price: dayMoneyIn(m.price_minor, m.currency, w.locale),
    left: dayMoneyIn(m.contribution_minor, m.currency, w.locale),
    pct: new Intl.NumberFormat(intlTag(w.locale), {
      style: "percent",
      maximumFractionDigits: 0,
    }).format(m.margin_pct / 100),
  };
}

const PROPOSAL_WORD: Record<string, { key: string; tone: string }> = {
  pending: { key: "proposal.pending", tone: "ok" },
  blocked: { key: "proposal.blocked", tone: "alarm" },
  approved: { key: "proposal.approved", tone: "ok" },
  rejected: { key: "proposal.rejected", tone: "none" },
  expired: { key: "proposal.expired", tone: "none" },
};

export function proposalWord(
  p: { status: string } | undefined,
  tr: Tr = ENGLISH().tr,
): { word: string; tone: string } | null {
  if (!p) return null;
  const known = PROPOSAL_WORD[p.status];
  if (known) return { word: tr(known.key), tone: known.tone };
  return { word: p.status.replace(/_/g, " "), tone: "none" };
}
