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
//   · Due by a date (I-54b, owner 2026-11-01): the open deals the owner
//     expects to close by PIPELINE.due_days from today (their own expected
//     close date, past ones included), their values × the same win rate.
//     Unlike the weighted value it has a window, so SYB's track record can
//     record it and grade it by the deals marked won by that day.
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
  /** I-54b: the window of the "due by" forecast, in days from today. */
  due_days: 30,
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
  /** YYYY-MM-DD: when the owner expects it to close; null or absent when they haven't said. */
  expected_close?: string | null;
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

/* ── due by a date (I-54b) ── */

export interface DueLine {
  currency: string;
  /** The deals in it, with the value each had when this was worked out. */
  deals: { id: string; amount_minor: number }[];
  total: Money;
  low: Money;
  high: Money;
}

export type DueForecast =
  | {
      ok: true;
      /** YYYY-MM-DD: the last day of the window. */
      by: string;
      lines: DueLine[];
      /** Deals due in the window with no value: left out of every figure, and counted. */
      unvalued: number;
      /** Of the deals in it, those whose expected close date has already passed. */
      overdue: number;
      /** Open deals with no expected close date: not in this forecast, and counted. */
      undated: number;
      basis: "measured" | "stated";
      sources: string[];
      assumed: string[];
    }
  | {
      ok: false;
      by: string;
      reason: string;
      undated: number;
    };

/** Pure: today + PIPELINE.due_days, YYYY-MM-DD. */
export function dueBy(today: string): string {
  return new Date(Date.parse(`${today}T00:00:00Z`) + PIPELINE.due_days * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

/**
 * Pure: of the open deals the owner expects to close by dueBy(today), how
 * much is likely won, low to high, per currency, from the same win rate as
 * the weighted value. It refuses without a win rate (rule 25), and when no
 * deal is due by then with a value; deals with no expected close date are
 * counted, never guessed into the window.
 */
export function dueByForecast(
  deals: readonly DealFacts[],
  rate: WinRate,
  today: string,
): DueForecast {
  const by = dueBy(today);
  const open = deals.filter((d) => isOpenStage(d.stage));
  const undated = open.filter((d) => !d.expected_close).length;
  if (rate.basis === "none") return { ok: false, by, reason: rate.reason, undated };
  const due = open.filter((d) => d.expected_close && d.expected_close <= by);
  const byCurrency = new Map<string, { id: string; amount_minor: number }[]>();
  let unvalued = 0;
  for (const d of due) {
    if (d.value === null) {
      unvalued++;
      continue;
    }
    const list = byCurrency.get(d.value.currency) ?? [];
    list.push({ id: d.id, amount_minor: d.value.amount_minor });
    byCurrency.set(d.value.currency, list);
  }
  if (byCurrency.size === 0) {
    return {
      ok: false,
      by,
      reason:
        due.length === 0
          ? `No open deal has an expected close date on or before ${by}. Give your deals an expected close date and I can say how much is likely won by then.`
          : `The deals expected to close by ${by} have no value yet, so I can't say how much is likely won.`,
      undated,
    };
  }
  const lines: DueLine[] = [...byCurrency.keys()].sort().map((currency) => {
    const list = byCurrency.get(currency)!;
    const total = money(
      list.reduce((s, d) => s + d.amount_minor, 0),
      currency,
    );
    return {
      currency,
      deals: list,
      total,
      low: multiply(total, rate.low),
      high: multiply(total, rate.high),
    };
  });
  const overdue = due.filter((d) => d.expected_close! < today).length;
  return {
    ok: true,
    by,
    lines,
    unvalued,
    overdue,
    undated,
    basis: rate.basis,
    sources: [
      `the expected close dates you gave on ${due.length} open deal${due.length === 1 ? "" : "s"}`,
      rate.basis === "measured"
        ? `your own win rate, from ${rate.closed.won + rate.closed.lost} deals you closed between ${rate.closed.from} and ${rate.closed.to}`
        : `your answer to question ${WIN_RATE_QUESTION}`,
    ],
    assumed: [
      ...rate.assumed,
      "each of these deals is won at that one rate, whatever its stage",
      "a deal counts as won by the date only if you mark it won in the pipeline by then",
      ...(overdue > 0
        ? [
            `${overdue} of them ${overdue === 1 ? "was" : "were"} expected earlier and ${overdue === 1 ? "is" : "are"} still open; ${overdue === 1 ? "it counts" : "they count"} as due now`,
          ]
        : []),
    ],
  };
}
