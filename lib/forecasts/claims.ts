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
//   cash_close   the cash forecast's next four weekly closing balances
//                (lib/cash), recorded only when cash today is an imported
//                bank statement's balance (I-54a, owner 2026-11-01): a
//                forecast that started from the owner's own figure could
//                only be graded against another statement it never had.
//                Graded by the statement's closing balance on the week's
//                last day.
//
//   pipeline_close  of the open deals the owner expects to close in the
//                next 30 days, how much is likely won (lib/pipeline,
//                I-54b, owner 2026-11-01). Graded by the deals the owner
//                marks won by that day, read from the deals' own stage
//                history, so reopening a deal later doesn't rewrite it.
//
// Not recorded, and why (TASKS-FEEDBACK.md I-54.2): the pipeline's
// weighted value, because it has no window: it weighs every open deal,
// whenever it closes, so no date ever closes the claim. Its windowed twin,
// pipeline_close above, is the one on record.

import type { forecastChecks } from "../../db/schema";
import { wholeMoney } from "../cash/model";
import { shortDate } from "../charts/model";
import type { CoverView } from "../stock/cover-load";
import { wholeDays } from "../stock/cover";
import type { SeasonsView } from "../seasons/load";
import type { CashForecast } from "../cash/model";
import type { DueForecast } from "../pipeline/maths";
import { addDays, ratioText } from "../seasons/forecast";
import { isoWeek } from "../summary/week";

export type ForecastKind = "stock_out" | "season_week" | "cash_close" | "pipeline_close";

/** I-54a: how many of the forecast's weeks go on the record. */
export const CASH_CLAIM_WEEKS = 4;

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
        `${longDay(r.normal.from)} to ${longDay(r.normal.to)}), measured by ${r.series.source}. ` +
        `One year is one example: it says what happened last year, not what will.`,
    });
  }
  return out;
}

/**
 * I-54a: the cash forecast's next four weekly closing balances, as claims,
 * when cash today is a bank statement's balance (OBSERVED, from the
 * balance import). Each week's range is the one on screen: the cautious
 * end to the hopeful end of the balance at the week's end. Once per ISO
 * week the forecast is made in: the first showing of a week is the one on
 * record, so looking at the screen every day doesn't record the same
 * forecast seven times.
 */
export function cashClaims(
  owner: Owner,
  forecast: CashForecast,
  balance: { connection_id: string } | null,
  now: Date,
): ForecastClaim[] {
  if (forecast.status !== "ready" || balance === null) return [];
  const start = forecast.start;
  const on = start.on;
  if (start.basis !== "OBSERVED" || !on) return [];
  const currency = forecast.currency;
  const week = isoWeek(now);
  return forecast.weeks.slice(0, CASH_CLAIM_WEEKS).map((w) => {
    const low = Math.min(w.balance.low, w.balance.high);
    const high = Math.max(w.balance.low, w.balance.high);
    return {
      account_id: owner.account_id,
      profile_id: owner.profile_id,
      kind: "cash_close",
      forecast_key: `cash_close|${currency}|${week}|${w.index}`,
      made_at: now.toISOString(),
      subject: "cash in the bank",
      subject_ref: {
        connection_id: balance.connection_id,
        source: "your bank statement",
        currency,
        started_from: { amount_minor: start.amount_minor, on },
        week_index: w.index,
      },
      metric: "cash.balance",
      unit: "money",
      window_start: w.start,
      window_end: w.end,
      low_minor: Math.floor(low),
      high_minor: Math.ceil(high),
      currency,
      claim: `Cash in the bank at the end of ${shortDate(w.end)}: ${wholeMoney(Math.floor(low), currency)}–${wholeMoney(Math.ceil(high), currency)}.`,
      basis:
        `Started from your bank statement's closing balance of ${wholeMoney(start.amount_minor, currency)} on ${longDay(on)}, ` +
        `with money in from ${forecast.series.source} ${forecast.series.noun} and money out from your costs list. ` +
        `Assumed: ${forecast.assumptions.join(" ")}`,
    };
  });
}

/**
 * I-54b: the pipeline's "likely won by" range, one claim per currency, as
 * shown: the due deals' total × the win rate's low and high. The deals and
 * the values they had go in subject_ref, so the grade reads the same deals.
 * Once per ISO week the forecast is made in.
 */
export function pipelineClaims(
  owner: Owner,
  due: DueForecast,
  today: string,
  now: Date,
): ForecastClaim[] {
  if (!due.ok) return [];
  const week = isoWeek(now);
  return due.lines.map((l) => {
    const n = l.deals.length;
    return {
      account_id: owner.account_id,
      profile_id: owner.profile_id,
      kind: "pipeline_close",
      forecast_key: `pipeline_close|${l.currency}|${week}`,
      made_at: now.toISOString(),
      subject: "deals won",
      subject_ref: {
        source: "your pipeline",
        currency: l.currency,
        deals: l.deals,
        total_minor: l.total.amount_minor,
        rate_basis: due.basis,
      },
      metric: "deals.won",
      unit: "money",
      window_start: today,
      window_end: due.by,
      // multiply() already rounded each end to whole minor units, exactly.
      low_minor: l.low.amount_minor,
      high_minor: l.high.amount_minor,
      currency: l.currency,
      claim: `Of the ${n} deal${n === 1 ? "" : "s"} you expect to close by ${longDay(due.by)} (${wholeMoney(l.total.amount_minor, l.currency)} in all), about ${wholeMoney(l.low.amount_minor, l.currency)}–${wholeMoney(l.high.amount_minor, l.currency)} is likely won.`,
      basis: `${due.sources.join("; ")}. Assumed: ${due.assumed.join("; ")}.`,
    };
  });
}
