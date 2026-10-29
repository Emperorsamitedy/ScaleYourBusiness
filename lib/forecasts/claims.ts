// SYB's forecasts as claims for its own track record — idea 54 (I-54.2).
// Pure: no database, no model, no clock.
//
// A claim is a forecast exactly as it was shown, taken from the code that
// already made it. Nothing new is forecast here: the range is the one on
// screen, turned into the record's columns. Two forecasts qualify, because
// each one's actual is measured later by a connected source:
//
//   stock_out    a stock-out warning's "runs out in about 4–6 days"
//                (lib/stock/cover), as dates from the day it was said.
//                Graded by the item's measured stock counts.
//   season_week  each of the next eight weeks set beside the same week last
//                year (lib/seasons): last year's range against the normal
//                week, times the normal week now, in the series' own units.
//                Graded by that week's measured total from the same source.
//
// Not recorded, and why (TASKS-FEEDBACK.md I-54.2): the cash forecast's
// balances, because no balance is ever measured (the cash in the bank is
// the owner's own answer, and no connector reads a balance); and the
// pipeline's weighted value, because it has no window: it weighs every open
// deal, whenever it closes, so no date ever closes the claim.

import type { forecastChecks } from "../../db/schema";
import { wholeMoney } from "../cash/model";
import { shortDate } from "../charts/model";
import type { CoverView } from "../stock/cover-load";
import { wholeDays } from "../stock/cover";
import type { SeasonsView } from "../seasons/load";
import { addDays, ratioText } from "../seasons/forecast";
import { isoWeek } from "../summary/week";

export type ForecastKind = "stock_out" | "season_week";

/** What one forecast writes, ungraded. */
export type ForecastClaim = Omit<
  typeof forecastChecks.$inferInsert,
  | "id"
  | "recorded_at"
  | "graded_at"
  | "verdict"
  | "actual_minor"
  | "actual_num"
  | "actual_date"
  | "actual_note"
  | "actual_source"
>;

interface Owner {
  account_id: string;
  profile_id: string;
}

/** The ISO date `n` whole days from `day`. */
const dayPlus = (day: string, n: number) => addDays(day, n);

/** "4 Nov 2026" — the record spans years, so it names them. */
export function longDay(day: string): string {
  return `${shortDate(day)} ${day.slice(0, 4)}`;
}

/**
 * The stock-out warnings of one business, as claims. Only a warning with
 * both ends is recorded: "about 30 days or more" has no day by which it
 * could be wrong. The dates are the warning's own whole days ("about 4–6
 * days", lib/stock/cover wholeDays) counted from the day it was said, so
 * the claim is the sentence the owner read. Once per item per ISO week,
 * the same once-a-week the warning itself keeps.
 */
export function stockClaims(owner: Owner, cover: CoverView, now: Date): ForecastClaim[] {
  const out: ForecastClaim[] = [];
  const week = isoWeek(now);
  for (const row of cover.warnings) {
    const c = row.cover;
    if (c.status !== "ready" || !c.warning || !c.cover || c.cover.high === null) continue;
    if (row.item.on_hand <= 0) continue;
    const [lo, hi] = wholeDays({ low: c.cover.low, high: c.cover.high });
    const today = cover.today;
    const low = dayPlus(today, lo);
    const high = dayPlus(today, hi);
    out.push({
      account_id: owner.account_id,
      profile_id: owner.profile_id,
      kind: "stock_out",
      forecast_key: `stock_out|${row.key}|${week}`,
      made_at: now.toISOString(),
      subject: row.name,
      subject_ref: {
        connection_id: row.item.connection_id,
        product_ref: row.item.ref,
        source: row.source,
        on_hand: row.item.on_hand,
        as_of: row.item.as_of,
      },
      metric: "stock.on_hand",
      unit: "date",
      window_start: today,
      window_end: high,
      low_date: low,
      high_date: high,
      claim: `${c.warning.sentence} That is between ${longDay(low)} and ${longDay(high)}.`,
      basis: `${c.sources}. Assumed: ${c.assumed.join("; ")}.`,
    });
  }
  return out;
}

/**
 * The next eight weeks of the busy-season forecast, as claims. Each is the
 * same week last year's range against the normal week ("1.9–2.3×"), times
 * the normal week now, in the series' own units: money in integer minor
 * units, rounded outward so the range is never narrower than shown; a
 * count to one decimal. Weeks already under way aren't recorded (part of
 * the answer is in), nor weeks last year didn't measure in full, nor a
 * range with no upper end. Once per week of the year: the same week last
 * year is the forecast every time it is shown, so the first showing is
 * the one on record.
 */
export function seasonClaims(owner: Owner, view: SeasonsView, now: Date): ForecastClaim[] {
  const r = view.result;
  const ref = view.series_ref;
  if (r.status !== "ready" || !ref) return [];
  const median = r.normal.median;
  if (!(median > 0)) return [];
  const currency = r.series.currency;
  const out: ForecastClaim[] = [];
  const value = (v: number) =>
    currency ? wholeMoney(v, currency) : `${Math.round(v)} ${r.series.noun}`;
  for (const a of r.ahead) {
    const ly = a.last_year;
    if (a.start < r.today || ly === null || ly.high === null) continue;
    // Outward, past float noise: 2.333 × 200,000 is 466,600, not 466,601.
    const lowV = ly.low * median + 1e-6;
    const highV = ly.high * median - 1e-6;
    const end = addDays(a.start, 6);
    const range =
      currency !== null
        ? { low_minor: Math.floor(lowV), high_minor: Math.ceil(highV), currency }
        : {
            low_num: (Math.floor(lowV * 10) / 10).toFixed(1),
            high_num: (Math.ceil(highV * 10) / 10).toFixed(1),
          };
    const lowWords = value(currency ? range.low_minor! : Number(range.low_num));
    const highWords = value(currency ? range.high_minor! : Number(range.high_num));
    out.push({
      account_id: owner.account_id,
      profile_id: owner.profile_id,
      kind: "season_week",
      forecast_key: `season_week|${ref.connection_id}|${ref.metric}|${currency ?? ""}|${a.start}`,
      made_at: now.toISOString(),
      subject: r.series.noun,
      subject_ref: {
        connection_id: ref.connection_id,
        metric: ref.metric,
        currency,
        source: r.series.source,
        last_year_start: a.last_year_start,
        last_year: { index: ly.index, low: ly.low, high: ly.high, value: ly.value },
        normal_median: median,
      },
      metric: ref.metric,
      unit: currency !== null ? "money" : "count",
      window_start: a.start,
      window_end: end,
      ...range,
      claim: `The week of ${shortDate(a.start)} to ${shortDate(end)}: ${lowWords}–${highWords} of ${r.series.noun}, if it runs as the same week did last year.`,
      basis:
        `Last year the week of ${longDay(a.last_year_start)} ran ${ratioText(ly)} your normal week, ` +
        `and your normal week is ${value(median)} (the median of ${r.normal.weeks} complete weeks, ` +
        `${shortDate(r.normal.from)} to ${longDay(r.normal.to)}), measured by ${r.series.source}. ` +
        `One year is one example: it says what happened last year, not what will.`,
    });
  }
  return out;
}
