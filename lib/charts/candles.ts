// Candles from a daily money series — the market chart's price pane
// (components/charts/MarketChart.tsx). Pure: no database, no clock.
//
// A bucket is a day, a Monday-to-Sunday week, or a calendar month. Within
// one bucket, over the days that were MEASURED (a missing day is absent,
// never a zero):
//
//   open    the first measured day's value
//   close   the last measured day's value
//   high    the best day
//   low     the worst day
//   volume  the sum of the volume series over the bucket's days — orders,
//           appointments and visits are daily flows, so they add up
//
// The opportunity overlay rides on the same buckets. Each day may carry
// the money that slipped that day, per component, as a low–high range
// (lib/charts/opportunity.ts). A bucket sums those, and the "what you'd
// have kept" line sits above the close by the bucket's average slip per
// measured day — the candle's unit is money per day, so the line's is too.
//
// Money stays integer minor units (rule 1): an average is rounded to the
// nearest minor unit, never left fractional.

import { weekStart } from "../care/chart-view";

export const BUCKETS = ["day", "week", "month"] as const;
export type Bucket = (typeof BUCKETS)[number];

/** The switch's own words: the trading-chart convention. */
export const BUCKET_LABEL: Readonly<Record<Bucket, string>> = {
  day: "1D",
  week: "1W",
  month: "1M",
};

/** How many buckets a full-width chart shows, and how many a phone shows. */
export const BUCKET_SPAN: Readonly<Record<Bucket, { wide: number; narrow: number }>> = {
  day: { wide: 90, narrow: 30 },
  week: { wide: 26, narrow: 13 },
  month: { wide: 12, narrow: 6 },
};

/** One component's slip on one day, or summed over a bucket: integer minor units. */
export interface SlipPart {
  key: string;
  low_minor: number;
  high_minor: number;
}

export interface DayPoint {
  /** "YYYY-MM-DD". */
  date: string;
  /** The price series that day, integer minor units. */
  value_minor: number;
  /** The volume series that day, or null when it wasn't measured. */
  volume: number | null;
  /** What slipped that day, per component; absent or empty when nothing did. */
  slip?: readonly SlipPart[];
}

export interface Candle {
  /** The bucket's first calendar day: the day, the Monday, or the 1st. */
  start: string;
  /** The first and last measured days inside it. */
  first: string;
  last: string;
  open_minor: number;
  high_minor: number;
  low_minor: number;
  close_minor: number;
  /** Measured days in the bucket. */
  days: number;
  /** Summed volume, or null when no day in the bucket measured it. */
  volume: number | null;
  /** Slip summed over the bucket, per component (only components that slipped). */
  slip: SlipPart[];
  slip_low_minor: number;
  slip_high_minor: number;
  /** close + the bucket's average slip per measured day: the dotted line. */
  kept_low_minor: number;
  kept_high_minor: number;
}

/** The first day of the bucket a day falls in. */
export function bucketStart(date: string, bucket: Bucket): string {
  if (bucket === "day") return date;
  if (bucket === "week") return weekStart(date);
  return `${date.slice(0, 7)}-01`;
}

/** Pure: the candles of a daily series, oldest first. Days are read in date order. */
export function bucketCandles(points: readonly DayPoint[], bucket: Bucket): Candle[] {
  const sorted = [...points].sort((a, b) => a.date.localeCompare(b.date));
  const out: Candle[] = [];
  const parts = new Map<string, Map<string, SlipPart>>();
  let current: Candle | null = null;
  for (const p of sorted) {
    if (!Number.isSafeInteger(p.value_minor)) continue;
    const start = bucketStart(p.date, bucket);
    if (current === null || current.start !== start) {
      current = {
        start,
        first: p.date,
        last: p.date,
        open_minor: p.value_minor,
        high_minor: p.value_minor,
        low_minor: p.value_minor,
        close_minor: p.value_minor,
        days: 0,
        volume: null,
        slip: [],
        slip_low_minor: 0,
        slip_high_minor: 0,
        kept_low_minor: 0,
        kept_high_minor: 0,
      };
      out.push(current);
      parts.set(start, new Map());
    }
    current.last = p.date;
    current.close_minor = p.value_minor;
    current.high_minor = Math.max(current.high_minor, p.value_minor);
    current.low_minor = Math.min(current.low_minor, p.value_minor);
    current.days += 1;
    if (p.volume !== null && Number.isFinite(p.volume)) {
      current.volume = (current.volume ?? 0) + p.volume;
    }
    const byKey = parts.get(start)!;
    for (const s of p.slip ?? []) {
      const acc = byKey.get(s.key) ?? { key: s.key, low_minor: 0, high_minor: 0 };
      acc.low_minor += s.low_minor;
      acc.high_minor += s.high_minor;
      byKey.set(s.key, acc);
    }
  }
  for (const c of out) {
    c.slip = [...(parts.get(c.start)?.values() ?? [])].filter(
      (s) => s.low_minor > 0 || s.high_minor > 0,
    );
    c.slip_low_minor = c.slip.reduce((n, s) => n + s.low_minor, 0);
    c.slip_high_minor = c.slip.reduce((n, s) => n + s.high_minor, 0);
    c.kept_low_minor = c.close_minor + Math.round(c.slip_low_minor / c.days);
    c.kept_high_minor = c.close_minor + Math.round(c.slip_high_minor / c.days);
  }
  return out;
}

/** The last `n` candles: what fits the width the chart is drawn at. */
export function lastBuckets(candles: readonly Candle[], n: number): Candle[] {
  return n >= candles.length ? [...candles] : candles.slice(candles.length - n);
}
