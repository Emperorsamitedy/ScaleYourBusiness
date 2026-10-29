// Grading SYB's forecasts — idea 54 (I-54.3). Pure: no database, no model,
// no clock. Same claim and same measured rows, same grade.
//
// A claim is graded once its window closed at least a day ago, against
// measured rows only (the conservative choice in TASKS-FEEDBACK.md):
//
//   inside      the measured actual fell within the range I gave;
//   above       it came in over the top (a week's sales), or later than
//               the latest day (stock that lasted longer);
//   below       under the bottom, or sooner than the earliest day;
//   cant_tell   the rows that would say aren't there, or something the
//               forecast didn't claim got in the way (a delivery of the
//               item). Counted apart, never as right.
//
// When the rows aren't in yet, the grade waits (null) rather than call it
// "can't tell" the day after: a sync can land a day late. After
// GRADE.patience_days past the window it is "can't tell" for good.

import type { forecastChecks } from "../../db/schema";
import { format, minorUnitExponent, money } from "../core/money";
import { wholeMoney } from "../cash/model";
import { addDays } from "../seasons/forecast";
import { longDay } from "./claims";

export const GRADE = {
  /** A window is graded once it closed at least this many whole days ago. */
  after_days: 1,
  /** Past its window by this many days, missing rows make it "can't tell" instead of waiting. */
  patience_days: 14,
} as const;

export type Verdict = "inside" | "above" | "below" | "cant_tell";

export type ClaimRow = Pick<
  typeof forecastChecks.$inferSelect,
  | "kind"
  | "unit"
  | "subject"
  | "subject_ref"
  | "metric"
  | "window_start"
  | "window_end"
  | "low_minor"
  | "high_minor"
  | "currency"
  | "low_num"
  | "high_num"
  | "low_date"
  | "high_date"
>;

export interface Grade {
  verdict: Verdict;
  actual_minor: number | null;
  actual_num: string | null;
  actual_date: string | null;
  actual_note: string;
  actual_source: { table: "metric_observations"; ids: string[] } | null;
}

/** One measured stock count of the item: units on hand on a day. */
export interface StockCount {
  id: string;
  date: string;
  on_hand: number;
}

/** One measured day of a series: integer minor units, or a count. */
export interface DayValue {
  id: string;
  date: string;
  value: number;
}

const DAY_MS = 86_400_000;
const daysBetween = (a: string, b: string) =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);
const days = (n: number) => `${n} day${n === 1 ? "" : "s"}`;

/** Its window closed at least GRADE.after_days whole days before today. */
export function isDue(windowEnd: string, today: string): boolean {
  return windowEnd <= addDays(today, -(GRADE.after_days + 1));
}

/** Waiting for rows is over: from here, missing rows mean "can't tell". */
function patienceOver(windowEnd: string, today: string): boolean {
  return windowEnd <= addDays(today, -GRADE.patience_days);
}

const sourceOf = (c: ClaimRow) => {
  const s = (c.subject_ref as { source?: unknown } | null)?.source;
  return typeof s === "string" && s !== "" ? s : "the connected source";
};

const cantTell = (note: string, ids: string[] = []): Grade => ({
  verdict: "cant_tell",
  actual_minor: null,
  actual_num: null,
  actual_date: null,
  actual_note: note,
  actual_source: ids.length > 0 ? { table: "metric_observations", ids } : null,
});

/**
 * A stock-out claim: "runs out between low_date and high_date", from the
 * units on hand counted on `as_of`. The day it runs out is the first day
 * its count is zero; counts come a day at a time at best. Walk the item's
 * later counts in order. A count above the one before is a delivery, which
 * the forecast didn't claim, so it can't be graded. The first count at
 * zero says the day fell after the count before it and by that one; that
 * span must sit inside the range to be "inside", and a span across an end
 * is "can't tell". A count still above zero on the latest day or after is
 * "above".
 */
export function gradeStockOut(
  claim: ClaimRow,
  counts: readonly StockCount[],
  today: string,
): Grade | null {
  const ref = claim.subject_ref as { on_hand?: unknown; as_of?: unknown };
  const low = claim.low_date;
  const high = claim.high_date;
  if (typeof ref.on_hand !== "number" || typeof ref.as_of !== "string" || !low || !high) {
    return cantTell("The forecast doesn't say what it started from, so I can't grade it.");
  }
  const source = sourceOf(claim);
  const asOf = ref.as_of;
  let prev = { date: asOf, on_hand: ref.on_hand };
  const read: string[] = [];
  const sorted = [...counts]
    .filter((c) => c.date > asOf)
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  for (const c of sorted) {
    read.push(c.id);
    const source_ = { table: "metric_observations" as const, ids: [...read] };
    if (c.on_hand > prev.on_hand) {
      return cantTell(
        `More came in: ${prev.on_hand} on hand on ${longDay(prev.date)}, ${c.on_hand} on ${longDay(c.date)}. A delivery moves the day it runs out, so I can't tell whether I was right.`,
        read,
      );
    }
    if (c.on_hand <= 0) {
      const at = {
        actual_minor: null,
        actual_num: "0",
        actual_date: c.date,
        actual_source: source_,
      };
      if (c.date < low) {
        return {
          verdict: "below",
          ...at,
          actual_note: `It ran out sooner: none left on ${longDay(c.date)} by ${source}'s count, at least ${days(daysBetween(c.date, low))} before the earliest day I gave (${longDay(low)}).`,
        };
      }
      if (addDays(prev.date, 1) >= low && c.date <= high) {
        return {
          verdict: "inside",
          ...at,
          actual_note: `It ran out inside the days I gave: ${prev.on_hand} left on ${longDay(prev.date)}, none on ${longDay(c.date)}, by ${source}'s count.`,
        };
      }
      return cantTell(
        `It ran out between ${longDay(prev.date)} and ${longDay(c.date)}, and ${source}'s counts are too far apart to say whether that was inside ${longDay(low)} to ${longDay(high)}.`,
        read,
      );
    }
    if (c.date >= high) {
      const when =
        c.date === high
          ? `on ${longDay(c.date)} by ${source}'s count, the latest day I gave`
          : `on ${longDay(c.date)} by ${source}'s count, ${days(daysBetween(high, c.date))} after the latest day I gave (${longDay(high)})`;
      return {
        verdict: "above",
        actual_minor: null,
        actual_num: String(c.on_hand),
        actual_date: c.date,
        actual_source: source_,
        actual_note: `It lasted longer: ${c.on_hand} still on hand ${when}. The counts between show no delivery.`,
      };
    }
    prev = { date: c.date, on_hand: c.on_hand };
  }
  if (!patienceOver(claim.window_end, today)) return null;
  return cantTell(
    `No count of it from ${source} after ${longDay(prev.date)}, so I can't tell whether it ran out in the days I gave.`,
    read,
  );
}

/** Money in whole units, or to the cent when the whole units would say nothing. */
function moneyWords(minor: number, currency: string): string {
  const unit = 10 ** minorUnitExponent(currency);
  return minor !== 0 && Math.round(minor / unit) === 0
    ? format(money(Math.round(minor), currency))
    : wholeMoney(minor, currency);
}

/**
 * A season week: the week's measured total from the same source, against
 * the range. Every day of the week must be measured — a missing day is a
 * gap, not a zero (connectors write a quiet day as a zero).
 */
export function gradeSeasonWeek(
  claim: ClaimRow,
  values: readonly DayValue[],
  today: string,
): Grade | null {
  const source = sourceOf(claim);
  const byDay = new Map<string, DayValue>();
  for (const v of values) {
    if (v.date >= claim.window_start && v.date <= claim.window_end && !byDay.has(v.date)) {
      byDay.set(v.date, v);
    }
  }
  const span = daysBetween(claim.window_start, claim.window_end) + 1;
  const ids = [...byDay.values()].sort((a, b) => (a.date < b.date ? -1 : 1)).map((v) => v.id);
  if (byDay.size < span) {
    if (!patienceOver(claim.window_end, today)) return null;
    return cantTell(
      `${days(span - byDay.size)} of the week ${span - byDay.size === 1 ? "wasn't" : "weren't"} measured by ${source}, so I can't tell what it came to.`,
      ids,
    );
  }
  const total = [...byDay.values()].reduce((s, v) => s + v.value, 0);
  const source_ = { table: "metric_observations" as const, ids };
  if (claim.unit === "money") {
    const cur = claim.currency!;
    const lo = claim.low_minor!;
    const hi = claim.high_minor!;
    const said = `It came to ${moneyWords(total, cur)}, measured by ${source}`;
    const base = {
      actual_minor: total,
      actual_num: null,
      actual_date: null,
      actual_source: source_,
    };
    if (total > hi) {
      return {
        verdict: "above",
        ...base,
        actual_note: `${said}: ${moneyWords(total - hi, cur)} over the top of the range.`,
      };
    }
    if (total < lo) {
      return {
        verdict: "below",
        ...base,
        actual_note: `${said}: ${moneyWords(lo - total, cur)} under the bottom of the range.`,
      };
    }
    return { verdict: "inside", ...base, actual_note: `${said}: inside the range.` };
  }
  const lo = Number(claim.low_num);
  const hi = Number(claim.high_num);
  const n = (x: number) => `${Math.round(x * 10) / 10} ${claim.subject}`;
  const said = `It came to ${n(total)}, measured by ${source}`;
  const base = {
    actual_minor: null,
    actual_num: String(total),
    actual_date: null,
    actual_source: source_,
  };
  if (total > hi) {
    return {
      verdict: "above",
      ...base,
      actual_note: `${said}: ${n(total - hi)} over the top of the range.`,
    };
  }
  if (total < lo) {
    return {
      verdict: "below",
      ...base,
      actual_note: `${said}: ${n(lo - total)} under the bottom of the range.`,
    };
  }
  return { verdict: "inside", ...base, actual_note: `${said}: inside the range.` };
}
