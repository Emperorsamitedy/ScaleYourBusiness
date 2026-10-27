// Pipeline maths — Phase 5 Session D (P5-15). Pure arithmetic, no database,
// no model (cost rule: this is counting, not inference).
//
//   · Win rate: the business's OWN, measured from its closed deals once
//     there are enough of them, else the owner's stated figure (6.1f), else
//     nothing. Never an industry average presented as theirs (rule 25).
//   · Weighted value: open deal values × that win rate, as a low–high
//     range, per currency and never mixed (rule 1), with its window, its
//     sources and what it ASSUMES named (rule 25).
//   · Stage ageing: days in the current stage, and days since the owner
//     last spoke to them (or since the deal was added, said so).
//   · Stale: an open deal with no next step, or a next step past its date.
//
// The thresholds are pinned in PIPELINE and tested at their boundaries.

import type { Money } from "../core/money";
import { money, multiply } from "../core/money";
import type { DealStage } from "./stages";
import { OPEN_STAGES, WIN_RATE_QUESTION, isOpenStage } from "./stages";

export const PIPELINE = {
  /** Closed deals (won + lost) in the window before a measured win rate is used. */
  min_closed_for_measured: 5,
  /** How far back closed deals count toward the measured rate. */
  window_days: 365,
  /** A stated win rate is the owner's estimate: ± this many percentage points. */
  stated_band_points: 10,
  /** The measured rate's range: a Wilson score interval at 90% (z = 1.645). */
  z: 1.645,
} as const;

const DAY_MS = 86_400_000;

export interface DealFacts {
  id: string;
  stage: DealStage;
  /** ISO timestamps. */
  stage_entered_at: string;
  created_at: string;
  closed_at: string | null;
  last_contact_at: string | null;
  value: Money | null;
  value_basis: "quoted" | "estimated" | null;
  next_step: string | null;
  /** YYYY-MM-DD. */
  next_step_due: string | null;
}

/** Whole days from an instant to the start of `today` (YYYY-MM-DD, UTC); never negative. */
export function daysSince(iso: string, today: string): number {
  const from = Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);
  const to = Date.parse(`${today}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to)) return 0;
  return Math.max(0, Math.round((to - from) / DAY_MS));
}

/* ── stage ageing ── */

export interface DealAge {
  days_in_stage: number;
  /** Days since the owner last spoke to them, or since the deal was added when that isn't stated. */
  days_quiet: number;
  quiet_from: "last_contact" | "added";
}

export function dealAge(deal: DealFacts, today: string): DealAge {
  const quietFrom = deal.last_contact_at ?? deal.created_at;
  return {
    days_in_stage: daysSince(deal.stage_entered_at, today),
    days_quiet: daysSince(quietFrom, today),
    quiet_from: deal.last_contact_at ? "last_contact" : "added",
  };
}

export interface StageAgeing {
  stage: DealStage;
  deals: number;
  /** Null for an empty stage. */
  oldest_days: number | null;
  median_days: number | null;
}

/** Per open stage: how many deals sit there and how long they have sat. */
export function stageAgeing(deals: readonly DealFacts[], today: string): StageAgeing[] {
  return OPEN_STAGES.map((stage) => {
    const ages = deals
      .filter((d) => d.stage === stage)
      .map((d) => daysSince(d.stage_entered_at, today))
      .sort((a, b) => a - b);
    if (ages.length === 0) return { stage, deals: 0, oldest_days: null, median_days: null };
    const mid = Math.floor(ages.length / 2);
    const median =
      ages.length % 2 === 1 ? ages[mid]! : Math.round((ages[mid - 1]! + ages[mid]!) / 2);
    return { stage, deals: ages.length, oldest_days: ages.at(-1)!, median_days: median };
  });
}

/* ── stale deals ── */

export type Staleness =
  { why: "no_next_step" } | { why: "overdue"; due: string; days_over: number };

/**
 * Null when the deal is closed or has a next step that isn't past its date
 * (a next step without a date is not stale: the owner hasn't promised a day).
 */
export function staleness(deal: DealFacts, today: string): Staleness | null {
  if (!isOpenStage(deal.stage)) return null;
  if (deal.next_step === null || deal.next_step.trim() === "") return { why: "no_next_step" };
  if (deal.next_step_due !== null && deal.next_step_due < today) {
    return {
      why: "overdue",
      due: deal.next_step_due,
      days_over: daysSince(deal.next_step_due, today),
    };
  }
  return null;
}

/** Stale open deals, the longest-quiet first. */
export function staleDeals(
  deals: readonly DealFacts[],
  today: string,
): { deal: DealFacts; stale: Staleness; age: DealAge }[] {
  return deals
    .map((deal) => ({ deal, stale: staleness(deal, today), age: dealAge(deal, today) }))
    .filter((x): x is { deal: DealFacts; stale: Staleness; age: DealAge } => x.stale !== null)
    .sort((a, b) => b.age.days_quiet - a.age.days_quiet || a.deal.id.localeCompare(b.deal.id));
}

/* ── win rate ── */

export interface ClosedCount {
  won: number;
  lost: number;
  /** The window the count covers, YYYY-MM-DD inclusive. */
  from: string;
  to: string;
}

/** Won and lost deals closed within the window ending today. */
export function closedInWindow(deals: readonly DealFacts[], today: string): ClosedCount {
  const from = new Date(Date.parse(`${today}T00:00:00Z`) - PIPELINE.window_days * DAY_MS)
    .toISOString()
    .slice(0, 10);
  let won = 0;
  let lost = 0;
  for (const d of deals) {
    if (d.closed_at === null) continue;
    const day = d.closed_at.slice(0, 10);
    if (day < from || day > today) continue;
    if (d.stage === "won") won++;
    else if (d.stage === "lost") lost++;
  }
  return { won, lost, from, to: today };
}

/** Wilson score interval for w successes in n trials, as fractions. */
export function wilson(
  w: number,
  n: number,
  z: number = PIPELINE.z,
): { low: number; high: number } {
  if (n <= 0) return { low: 0, high: 1 };
  const p = w / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z / denom) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return { low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

export type WinRate =
  | {
      basis: "measured";
      /** Fractions 0–1. */
      point: number;
      low: number;
      high: number;
      closed: ClosedCount;
      /** The owner's own figure, shown beside the measured one, never swapped in silently. */
      stated: number | null;
      assumed: string[];
    }
  | {
      basis: "stated";
      point: number;
      low: number;
      high: number;
      closed: ClosedCount;
      stated: number;
      /** Closed deals still needed before the rate is measured instead. */
      needed: number;
      assumed: string[];
    }
  | {
      basis: "none";
      closed: ClosedCount;
      needed: number;
      reason: string;
    };

/** `stated` is the owner's answer to 6.1f, a percentage 0–100, or null. */
export function winRate(args: {
  deals: readonly DealFacts[];
  stated: number | null;
  today: string;
}): WinRate {
  const closed = closedInWindow(args.deals, args.today);
  const n = closed.won + closed.lost;
  const stated =
    args.stated !== null && Number.isFinite(args.stated) && args.stated >= 0 && args.stated <= 100
      ? args.stated
      : null;
  const needed = Math.max(0, PIPELINE.min_closed_for_measured - n);
  if (n >= PIPELINE.min_closed_for_measured) {
    const range = wilson(closed.won, n);
    return {
      basis: "measured",
      point: closed.won / n,
      low: range.low,
      high: range.high,
      closed,
      stated,
      assumed: [
        `the next deals close the way your last ${n} did (${closed.won} won, ${closed.lost} lost, ${closed.from} to ${closed.to}); the range is how far ${n} deals can mislead`,
      ],
    };
  }
  if (stated !== null) {
    const band = PIPELINE.stated_band_points;
    return {
      basis: "stated",
      point: stated / 100,
      low: Math.max(0, stated - band) / 100,
      high: Math.min(100, stated + band) / 100,
      closed,
      stated,
      needed,
      assumed: [
        `your own win rate of ${stated}% (question ${WIN_RATE_QUESTION}), give or take ${band} points: it's your estimate, not a measurement`,
      ],
    };
  }
  return {
    basis: "none",
    closed,
    needed,
    reason: `I don't know your win rate yet: ${n} deal${n === 1 ? "" : "s"} closed in the last ${PIPELINE.window_days} days, and I need ${PIPELINE.min_closed_for_measured} to measure it. Tell me roughly what share you win (question ${WIN_RATE_QUESTION}) and I can weigh your open deals now.`,
  };
}

/* ── weighted value ── */

export interface WeightedLine {
  currency: string;
  /** Open deals with a value in this currency. */
  deals: number;
  open_total: Money;
  low: Money;
  high: Money;
}

export type Weighted =
  | {
      ok: true;
      lines: WeightedLine[];
      /** Open deals with no value — left out of every figure, and counted. */
      unvalued: number;
      /** Open deals whose value is the owner's estimate rather than a quote. */
      estimated: number;
      basis: "measured" | "stated";
      window: { from: string; to: string };
      sources: string[];
      assumed: string[];
    }
  | {
      ok: false;
      reason: string;
      can: string[];
      cant: string[];
      ready_when: string;
      unvalued: number;
      /** What is open, unweighted, per currency — a sum, not a forecast. */
      open_totals: Money[];
    };

/**
 * Open deal values × the win rate, low to high, per currency. Without a
 * win rate it refuses, and says what it can and can't say (rule 25).
 */
export function weightedValue(deals: readonly DealFacts[], rate: WinRate): Weighted {
  const open = deals.filter((d) => isOpenStage(d.stage));
  const byCurrency = new Map<string, { total: number; deals: number }>();
  let unvalued = 0;
  let estimated = 0;
  for (const d of open) {
    if (d.value === null) {
      unvalued++;
      continue;
    }
    if (d.value_basis === "estimated") estimated++;
    const line = byCurrency.get(d.value.currency) ?? { total: 0, deals: 0 };
    line.total += d.value.amount_minor;
    line.deals++;
    byCurrency.set(d.value.currency, line);
  }
  const currencies = [...byCurrency.keys()].sort();
  const totals = currencies.map((c) => money(byCurrency.get(c)!.total, c));

  if (rate.basis === "none") {
    return {
      ok: false,
      reason: rate.reason,
      can: [
        "list your open deals, their values and how long each has sat in its stage",
        "say which deals have no next step, or a next step past its date",
      ],
      cant: [
        "say how much of what is open you are likely to win",
        "borrow a win rate from other businesses and call it yours",
      ],
      ready_when:
        rate.needed > 0
          ? `after ${rate.needed} more closed deal${rate.needed === 1 ? "" : "s"}, or as soon as you state your win rate`
          : "as soon as you state your win rate",
      unvalued,
      open_totals: totals,
    };
  }

  const lines: WeightedLine[] = currencies.map((currency, i) => {
    const total = totals[i]!;
    return {
      currency,
      deals: byCurrency.get(currency)!.deals,
      open_total: total,
      low: multiply(total, rate.low),
      high: multiply(total, rate.high),
    };
  });
  const n = rate.closed.won + rate.closed.lost;
  return {
    ok: true,
    lines,
    unvalued,
    estimated,
    basis: rate.basis,
    window: { from: rate.closed.from, to: rate.closed.to },
    sources: [
      `your pipeline: ${open.length} open deal${open.length === 1 ? "" : "s"}`,
      rate.basis === "measured"
        ? `${n} deals you closed between ${rate.closed.from} and ${rate.closed.to}`
        : `your answer to question ${WIN_RATE_QUESTION}`,
    ],
    assumed: [
      ...rate.assumed,
      "every open deal closes at that one rate, whatever its stage — an early lead likely closes less often than a proposal sent, so read the low end first",
      ...(estimated > 0
        ? [
            `${estimated} value${estimated === 1 ? " is" : "s are"} your estimate rather than a quote, and count the same`,
          ]
        : []),
    ],
  };
}
