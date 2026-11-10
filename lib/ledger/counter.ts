// The headline counter and the calibration score — the v1 build spec §3.4
// and §3.6 (P7-37, P7-38).
//
//   verified_euro = SUM(net) WHERE verdict IN ('verified_gain', 'loss')
//                   AND confidence_grade IN ('A', 'B', 'C')
//                   AND window_end <= now()
//
// Losses are in it: a counter that only adds is not a proof ledger.
// Inconclusive verdicts and unmeasurable plans are left out of the number
// and counted beside it as "not yet proven". SYB's own fee for the period
// is its own line, never hidden in the net. Shadow plans ran nothing, so
// they never reach the counter.
//
// Per currency, never converted (rule 1). For each plan the standing entry
// is its latest correction, else its close.

import { and, eq, lte } from "drizzle-orm";
import { db } from "../../db";
import { ledgerEntries, measurementPlans } from "../../db/schema";
import type { Money } from "../core/money";
import { money, perUnit, ratioBp } from "../core/money";
import type { Entry } from "./chain";
import type { Plan } from "./plans";

export interface HeadlineCounter {
  /** Net verified money per currency — gains and losses both. */
  verified: Money[];
  /** The losses inside that number, per currency, shown — never netted out of sight. */
  losses: Money[];
  /** SYB's fee for the period, per currency; empty while nothing is charged. */
  fee: Money[];
  /** verified − fee, per currency. */
  net_of_fee: Money[];
  /** Closed but not proven: inconclusive verdicts and unmeasurable plans, counted apart. */
  not_yet_proven: { inconclusive: number; unmeasurable: number };
  /** Every plan the number is made of, so each figure traces to a plan id (§3.7). */
  plan_ids: string[];
}

interface Row {
  entry: Entry;
  plan: Plan;
}

/** The standing entry per plan for these rows. */
function standing(rows: readonly Row[]): Row[] {
  const byPlan = new Map<string, Row>();
  for (const r of rows) {
    const held = byPlan.get(r.plan.id);
    if (!held || r.entry.seq > held.entry.seq) byPlan.set(r.plan.id, r);
  }
  return [...byPlan.values()];
}

function add(totals: Map<string, number>, currency: string, minor: number): void {
  totals.set(currency, (totals.get(currency) ?? 0) + minor);
}

const asMoney = (totals: Map<string, number>) =>
  [...totals].sort(([a], [b]) => a.localeCompare(b)).map(([c, m]) => money(m, c));

/** Pure: the counter from rows and the period's fee. */
export function counterOf(rows: readonly Row[], fee: readonly Money[] = []): HeadlineCounter {
  const verified = new Map<string, number>();
  const losses = new Map<string, number>();
  const planIds: string[] = [];
  let inconclusive = 0;
  let unmeasurable = 0;
  for (const { entry, plan } of standing(rows)) {
    if (plan.shadow) continue;
    if (plan.design === "unmeasurable") {
      unmeasurable += 1;
      continue;
    }
    if (entry.verdict === "inconclusive") {
      inconclusive += 1;
      continue;
    }
    if (entry.verdict !== "verified_gain" && entry.verdict !== "loss") continue;
    if (!["A", "B", "C"].includes(plan.confidence_grade) || entry.net_minor === null) continue;
    add(verified, entry.currency, entry.net_minor);
    if (entry.verdict === "loss" || entry.net_minor < 0)
      add(losses, entry.currency, entry.net_minor);
    planIds.push(plan.id);
  }
  const net = new Map(verified);
  for (const f of fee) add(net, f.currency, -f.amount_minor);
  return {
    verified: asMoney(verified),
    losses: asMoney(losses),
    fee: [...fee],
    net_of_fee: asMoney(net),
    not_yet_proven: { inconclusive, unmeasurable },
    plan_ids: planIds,
  };
}

async function rowsFor(profileId: string | null, now: Date): Promise<Row[]> {
  const rows = await db
    .select({ entry: ledgerEntries, plan: measurementPlans })
    .from(ledgerEntries)
    .innerJoin(measurementPlans, eq(measurementPlans.id, ledgerEntries.plan_id))
    .where(
      and(
        profileId === null ? undefined : eq(ledgerEntries.profile_id, profileId),
        lte(measurementPlans.window_end, now.toISOString()),
      ),
    );
  return rows;
}

/**
 * The business's headline counter. `fee` is what SYB charged for the period
 * — empty while payments aren't armed, and then the line says nothing was
 * charged rather than vanishing.
 */
export async function headlineCounter(
  profileId: string,
  args: { now?: Date; fee?: readonly Money[] } = {},
): Promise<HeadlineCounter> {
  return counterOf(await rowsFor(profileId, args.now ?? new Date()), args.fee ?? []);
}

/** §3.6's window: the trailing 20 closed plans. */
export const CALIBRATION_PLANS = 20;

export interface Calibration {
  /** Median absolute forecast error as a percentage of the expected effect; null with no scored plan. */
  median_error_pct: number | null;
  /** How many plans it is the median of (≤ 20). */
  plans: number;
}

/** Pure: the calibration of these rows — the trailing 20 scored, forecast plans. */
export function calibrationOf(rows: readonly Row[]): Calibration {
  const scored = standing(rows)
    .filter(
      ({ entry, plan }) =>
        !plan.shadow && entry.forecast_error_minor !== null && plan.expected_effect_minor !== 0,
    )
    .sort((a, b) => Date.parse(b.plan.window_end) - Date.parse(a.plan.window_end))
    .slice(0, CALIBRATION_PLANS);
  if (scored.length === 0) return { median_error_pct: null, plans: 0 };
  // Each error in basis points of its forecast, exact integers (hard rule 1).
  const errors = scored
    .map(({ entry, plan }) =>
      ratioBp(Math.abs(entry.forecast_error_minor!), Math.abs(plan.expected_effect_minor)),
    )
    .sort((a, b) => a - b);
  const mid = Math.floor(errors.length / 2);
  // Twice the median, so an even count's midpoint stays whole; then to tenths of a percent.
  const twiceMedian = errors.length % 2 === 1 ? 2 * errors[mid]! : errors[mid - 1]! + errors[mid]!;
  const tenths = perUnit(twiceMedian, 20);
  return { median_error_pct: tenths / 10, plans: scored.length };
}

/** Per business, or across every business when profileId is null (§3.6: "and globally"). */
export async function calibration(
  profileId: string | null,
  now = new Date(),
): Promise<Calibration> {
  return calibrationOf(await rowsFor(profileId, now));
}
