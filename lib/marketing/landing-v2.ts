// The illustrative store behind the v2 landing page (app/landing-v2) —
// one fictional ceramics shop, the same one in every section. Pure, and
// safe in the browser. Every amount is integer minor units in one
// currency (rule 1); every derived figure is worked out here from the
// figures it rests on (rule 6), so the page can show its working and
// landing-v2.test.ts can hold the sums. Nothing on the page types a
// figure into a message (rule 3 of TASKS-LANGUAGES.md): the component
// formats these in the reader's language. Money arithmetic goes through
// lib/core/money.ts (hard rule 1: no float on a monetary path).

import { ratioBp, roundMinorTo, scaleMinorBy } from "../core/money";

export const V2_CURRENCY = "EUR";

/** One euro in minor units: the page rounds monthly estimates to whole euros. */
const UNIT = 100;

export const V2 = {
  /** Facts on the sheet before the interview demo adds its own. */
  facts: 381,
  /** Facts once the hero tour has read the connections. */
  tourFacts: 382,
  revenueDays: 28,
  revenue_minor: 5_601_200,
  /** Blended margin, one decimal. */
  marginPct: 71.6,
  shippingLow_minor: 900,
  shippingHigh_minor: 1_200,
  cashOptions_minor: [250_000, 500_000, 950_000],
  /** The day the owner answered the shipping question. */
  toldOn: "2026-11-12",
  /** One ad campaign, from the ad platform's own figures over `days`. */
  ad: { spent_minor: 41_951, back_minor: 33_077, days: 14 },
  /** A month, for turning a 14-day loss into a monthly one. */
  monthDays: 30,
  mug: { now_minor: 3_400, risePct: 8 },
  decideBy: "2026-11-28",
  ledger: { onRecord: 5, lastDay: "2026-11-12", waiting: 1 },
  forecast: {
    from: "2026-12-14",
    to: "2026-12-20",
    low_minor: 1_598_100,
    high_minor: 2_039_600,
  },
  chartDays: 60,
  /** The free check's length, as the page promises it ("in three minutes"). */
  checkMinutes: 3,
  /** The Autonomous guarantee: verified gains of this many times the fee. */
  guaranteeTimes: 3,
  firm: {
    clients: 48,
    rows: [
      { key: "bike", leaking_minor: 38_000, leaks: 2 },
      { key: "ceramics", leaking_minor: 118_000, leaks: 5 },
      { key: "salon", leaking_minor: 94_000, leaks: 4 },
      { key: "cafe", leaking_minor: 61_000, leaks: 3 },
    ],
  },
  /** The free-check demo: a fixed rule of thumb, said as one on the page. */
  check: {
    min_minor: 500_000,
    max_minor: 10_000_000,
    step_minor: 100_000,
    start_minor: 2_500_000,
    /** Likely share of monthly sales leaking, in basis points: low and high. */
    rates_bp: { shop: [200, 500], salon: [300, 700], cafe: [250, 600] },
  },
} as const;

export type CheckKind = keyof typeof V2.check.rates_bp;

/** What the campaign lost over its window: spent minus what came back. */
export function adLost_minor(): number {
  return V2.ad.spent_minor - V2.ad.back_minor;
}

/** The window's loss as a month's, to the whole euro: lost × 30 ÷ 14. */
export function adMonthly_minor(): number {
  return roundMinorTo(scaleMinorBy(adLost_minor(), V2.monthDays, V2.ad.days), UNIT);
}

/** What came back for every euro spent, in minor units of one euro (79 = €0.79). */
export function adReturnPerEuro_minor(): number {
  return scaleMinorBy(V2.ad.back_minor, UNIT, V2.ad.spent_minor);
}

/** The share of the spend that came back and that was lost, in percent, summing to 100. */
export function adSplitPct(): { back: number; lost: number } {
  const backBp = ratioBp(V2.ad.back_minor, V2.ad.spent_minor);
  return { back: backBp / 100, lost: (10_000 - backBp) / 100 }; // not money: a share shown as a bar width
}

/** The mug's price after the proposed rise, to the cent. */
export function mugAfter_minor(): number {
  return scaleMinorBy(V2.mug.now_minor, 100 + V2.mug.risePct, 100);
}

export type Severity = "high" | "medium" | "low";

export interface ScanLeak {
  key: "breakage" | "ads" | "pricing" | "bowl" | "repeat";
  area: "operations" | "marketing" | "pricing" | "product" | "customers";
  severity: Severity;
  /** How far through the scan (0–1) this leak is found. */
  at: number;
  /** A month, in minor units; null while the leak has no price yet. */
  low_minor: number | null;
  high_minor: number | null;
}

/** The five leaks of the diagnosis, in the order the scan finds them. */
export function scanLeaks(): ScanLeak[] {
  const ads = adMonthly_minor();
  return [
    {
      key: "breakage",
      area: "operations",
      severity: "high",
      at: 0.14,
      low_minor: null,
      high_minor: null,
    },
    { key: "ads", area: "marketing", severity: "high", at: 0.3, low_minor: ads, high_minor: ads },
    {
      key: "pricing",
      area: "pricing",
      severity: "medium",
      at: 0.46,
      low_minor: 13_400,
      high_minor: 123_800,
    },
    {
      key: "bowl",
      area: "product",
      severity: "medium",
      at: 0.62,
      low_minor: 46_100,
      high_minor: 89_500,
    },
    {
      key: "repeat",
      area: "customers",
      severity: "low",
      at: 0.78,
      low_minor: null,
      high_minor: null,
    },
  ];
}

/** What the scan has found by `progress` (0–1): the count, the unpriced, and the priced range. */
export function scanTotal(progress: number): {
  found: number;
  unpriced: number;
  low_minor: number;
  high_minor: number;
} {
  let found = 0;
  let unpriced = 0;
  let low = 0;
  let high = 0;
  for (const l of scanLeaks()) {
    if (progress < l.at) continue;
    found += 1;
    if (l.low_minor === null || l.high_minor === null) unpriced += 1;
    else {
      low += l.low_minor;
      high += l.high_minor;
    }
  }
  return { found, unpriced, low_minor: low, high_minor: high };
}

export interface Candle {
  open_minor: number;
  high_minor: number;
  low_minor: number;
  close_minor: number;
  /** The day's close plus what slipped away that day. */
  slipped_minor: number;
}

/** Share of a day's sales that slipped away, in basis points (the amber band). */
export const SLIP_BP = 900;

/**
 * Sixty fictional days of sales: a weekly rhythm, a gentle rise, and a
 * fixed pseudo-random wobble, so the chart is the same on every load.
 * Whole euros, as minor units.
 */
export function chartSeries(): Candle[] {
  const week = [0.84, 0.9, 0.95, 1, 1.08, 1.22, 1.16];
  const out: Candle[] = [];
  let seed = 11;
  let prev = 1_700;
  for (let i = 0; i < V2.chartDays; i++) {
    seed = (seed * 9301 + 49297) % 233280;
    const r = seed / 233280;
    const close = Math.round(
      1_700 * (week[i % 7] ?? 1) * (1 + (r - 0.5) * 0.34) * (1 + (i / V2.chartDays) * 0.22),
    );
    out.push({
      open_minor: prev * UNIT,
      high_minor: Math.round(Math.max(prev, close) * 1.03) * UNIT,
      low_minor: Math.round(Math.min(prev, close) * 0.96) * UNIT,
      close_minor: close * UNIT,
      slipped_minor: Math.round((close * (10_000 + SLIP_BP)) / 10_000) * UNIT,
    });
    prev = close;
  }
  return out;
}

/** The free-check demo's likely leak for a month's sales, each end to the nearest ten euros. */
export function checkRange(
  kind: CheckKind,
  sales_minor: number,
): { low_minor: number; high_minor: number } {
  const [lo, hi] = V2.check.rates_bp[kind];
  const ten = 10 * UNIT;
  const at = (bp: number) => roundMinorTo(scaleMinorBy(sales_minor, bp, 10_000), ten);
  return { low_minor: at(lo), high_minor: at(hi) };
}

/** The client book sorted the way the firm reads it: most money leaking first. */
export function firmRowsSorted(): (typeof V2.firm.rows)[number][] {
  return [...V2.firm.rows].sort((a, b) => b.leaking_minor - a.leaking_minor);
}
