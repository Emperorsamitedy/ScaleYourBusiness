// The watching screen's arithmetic (the owner's Watching design,
// 2026-10-17) — pure, no database, so the screen's every figure is
// pinned by a test. The loader beside it (./signals) reads; this decides.
//
//   watch days   which day of the watch today is, out of how many — the
//                same count the menu prints ("day 19 / 28")
//   a signal     one business-wide daily series the anomaly layer judges
//                (lib/anomaly/detect): its days read since the watch
//                began, its first watch week against its last seven
//                days, and its status, read from the same rules —
//                    DRIFTING     an open anomaly (a notice)
//                    INTERRUPTED  an open anomaly past an interrupt rule
//                    THIN         too little history for a usual range
//                    STEADY       otherwise

import { MIN_BASELINE_DAYS, computeBaseline, shiftDay } from "../anomaly/baseline";

const DAY_MS = 86_400_000;

/** A Postgres timestamp ("2026-10-27 00:00:00+00") or ISO string, as epoch ms. */
export function parseInstant(at: string): number {
  return Date.parse(at.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00"));
}

export interface WatchDays {
  /** Today's calendar day of the watch, 1-based and capped at `of`. */
  day: number;
  of: number;
  /** YYYY-MM-DD — day 1. */
  start: string;
  /** YYYY-MM-DD — the review date, when the watch ends. */
  end: string;
  days_remaining: number;
}

/** The watch's day count from the latest decision; null when no watch runs. */
export function watchDays(
  decision: { mode: string; watch_weeks: number | null; review_at: string } | null,
  now: Date,
): WatchDays | null {
  if (!decision || decision.mode !== "watching" || !decision.watch_weeks) return null;
  const of = decision.watch_weeks * 7;
  const reviewMs = parseInstant(decision.review_at);
  if (Number.isNaN(reviewMs)) return null;
  // Calendar days, so a log entry's day and today's day are counted alike:
  // day `of` is the review date itself, day 1 the `of - 1` days before it.
  const end = new Date(reviewMs).toISOString().slice(0, 10);
  const start = shiftDay(end, -(of - 1));
  const today = now.toISOString().slice(0, 10);
  const elapsed = Math.round(
    (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / DAY_MS,
  );
  return {
    day: Math.min(of, Math.max(1, elapsed + 1)),
    of,
    start,
    end,
    days_remaining: Math.max(0, Math.ceil((reviewMs - now.getTime()) / DAY_MS)),
  };
}

/** The series the watch reads — business-wide only, as the anomaly layer reads them. */
export const WATCHED_METRICS = [
  "revenue.daily",
  "orders.daily",
  "sessions.daily",
  "ad_spend.daily",
  "ad_purchases.daily",
  // Bookings (specs/bookings.md §4): watched like orders and revenue.
  "appointments_completed.daily",
  "booking_revenue.daily",
] as const;
export type WatchedMetric = (typeof WATCHED_METRICS)[number];

export const SIGNAL_NOUN: Readonly<Record<WatchedMetric, string>> = {
  "revenue.daily": "Revenue",
  "orders.daily": "Orders",
  "sessions.daily": "Website visits",
  "ad_spend.daily": "Ad spend",
  "ad_purchases.daily": "Ad purchases",
  "appointments_completed.daily": "Completed appointments",
  "booking_revenue.daily": "Booking revenue",
};

export type SignalStatus = "steady" | "drifting" | "interrupted" | "thin";

export interface WatchSignal {
  key: string;
  metric_key: WatchedMetric;
  noun: string;
  /** ISO 4217 for money series; null for counts. */
  currency: string | null;
  /** The connector's own name ("Stripe"). */
  read_from: string;
  /** Days on record since the watch began. */
  readings: number;
  /** Mean per day over the watch's first seven days; null until a second week exists. */
  first_week: number | null;
  /** Mean per day over the last seven days on record. */
  last_week: number | null;
  status: SignalStatus;
  /** For an open anomaly: which way, and since when. */
  direction: "drop" | "spike" | null;
  since: string | null;
}

export interface OpenAnomaly {
  severity: "notice" | "interrupt";
  direction: "drop" | "spike";
  first_date: string;
}

function meanBetween(values: ReadonlyMap<string, number>, from: string, to: string): number | null {
  let sum = 0;
  let n = 0;
  for (let d = from; d <= to; d = shiftDay(d, 1)) {
    const v = values.get(d);
    if (v !== undefined) {
      sum += v;
      n += 1;
    }
  }
  return n > 0 ? sum / n : null;
}

/** Pure: one series' row in "What I'm watching". */
export function summariseSeries(args: {
  values: ReadonlyMap<string, number>;
  watchStart: string;
  open: OpenAnomaly | null;
}): Pick<WatchSignal, "readings" | "first_week" | "last_week" | "status" | "direction" | "since"> {
  const { values, watchStart, open } = args;
  const dates = [...values.keys()].sort();
  const end = dates.at(-1) ?? null;
  const readings = dates.filter((d) => d >= watchStart).length;
  const lastWeek = end ? meanBetween(values, shiftDay(end, -6), end) : null;
  // A first week only means something once the last seven days are a different seven.
  const firstWeek =
    end && end >= shiftDay(watchStart, 13)
      ? meanBetween(values, watchStart, shiftDay(watchStart, 6))
      : null;

  let status: SignalStatus;
  if (open) status = open.severity === "interrupt" ? "interrupted" : "drifting";
  else if (end === null || computeBaseline(values, end) === null) status = "thin";
  else status = "steady";

  return {
    readings,
    first_week: firstWeek,
    last_week: lastWeek,
    status,
    direction: open?.direction ?? null,
    since: open?.first_date ?? null,
  };
}

export const THIN_RULE = `fewer than ${MIN_BASELINE_DAYS} of the last 28 days on record`;

/** "6 steady · 2 drifting · 1 thin" — only the counts that exist. */
export function statusTally(signals: readonly Pick<WatchSignal, "status">[]): string {
  const order: SignalStatus[] = ["steady", "drifting", "interrupted", "thin"];
  return order
    .map((s) => [s, signals.filter((x) => x.status === s).length] as const)
    .filter(([, n]) => n > 0)
    .map(([s, n]) => `${n} ${s}`)
    .join(" · ");
}

/** Watch-log kinds that are something noticed, rather than routine work. */
export const NOTED_KINDS: ReadonlySet<string> = new Set([
  "anomaly_detected",
  "watch_interrupted",
  "anomaly_cleared",
  "hours_findings",
  "goal_alert",
  "competitor_change", // feature 35: a competitor's price, offer or rating moved
  "cash_warning", // P5-08: the cash forecast's first tight week, or its clearing
]);

/** The watch day a log entry fell on; null when it predates the watch. */
export function dayOfWatch(at: string, start: string, of: number): number | null {
  const ms = parseInstant(at);
  if (Number.isNaN(ms)) return null;
  const day = new Date(ms).toISOString().slice(0, 10);
  const n = Math.round(
    (Date.parse(`${day}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / DAY_MS,
  );
  if (Number.isNaN(n) || n < 0) return null;
  return Math.min(of, n + 1);
}
