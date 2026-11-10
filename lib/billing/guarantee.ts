// The quarterly guarantee — the v1 build spec §8.4, computed as the
// multi-market spec §A.5 requires.
//
//   "If the Proof Ledger does not show at least 3× your fee in verified
//    money over a quarter, the next quarter is free."
//
// Entirely in the subscription's billing currency: verified gains and losses
// in that currency, the fee in that currency, the threshold as a ratio.
// Nothing here converts anything — an FX move must never grant or withhold
// a credit nobody earned — and a test fails if a conversion is touched. A
// ledger entry in another currency isn't counted, and the result says how
// many were left out rather than converting them.
//
// The rules (§8.4): Autonomous tier only; only plans graded A, B or C; at
// least 8 closed plans in the quarter, or it rolls forward instead of
// paying out; automatic, from ledger entries alone, reproducible by an
// auditor from the same rows.

import type { Money } from "../core/money";
import { money, ratioOf } from "../core/money";

export const GUARANTEE = {
  tier: "autonomous",
  /** 3× the fee, as basis points of it. */
  threshold_bp: 30_000,
  min_closed_plans: 8,
  grades: ["A", "B", "C"] as readonly string[],
} as const;

/** One plan's standing entry in the quarter, as the ledger holds it. */
export interface GuaranteeEntry {
  plan_id: string;
  verdict: "verified_gain" | "no_effect" | "loss" | "inconclusive";
  /** Signed, in `currency`'s minor units; null when unscored. */
  net_minor: number | null;
  currency: string;
  /** The plan's confidence grade. */
  grade: string;
  shadow: boolean;
}

export type GuaranteeResult =
  | { applies: false; reason: "not_autonomous" }
  | {
      applies: true;
      outcome: "met" | "credit" | "rolled_forward";
      closed_plans: number;
      /** Net verified money in the billing currency (gains and losses). */
      verified: Money;
      fee: Money;
      /** verified ÷ fee in basis points; null when the fee is zero. */
      ratio_bp: number | null;
      threshold_bp: number;
      /** The next quarter's fee, credited — only when the threshold wasn't met. */
      credit: Money | null;
      /** Entries in another currency, left out, never converted. */
      other_currency_entries: number;
    };

/** Pure: the guarantee for one quarter, from ledger entries alone. */
export function evaluateGuarantee(args: {
  tier: string;
  /** The subscription's fee for the quarter, in its billing currency. */
  fee: Money;
  entries: readonly GuaranteeEntry[];
}): GuaranteeResult {
  if (args.tier !== GUARANTEE.tier) return { applies: false, reason: "not_autonomous" };
  const currency = args.fee.currency;
  const real = args.entries.filter((e) => !e.shadow);
  const closed = real.length;
  let verified = 0;
  let otherCurrency = 0;
  for (const e of real) {
    if (e.currency !== currency) {
      otherCurrency += 1;
      continue;
    }
    if (e.verdict !== "verified_gain" && e.verdict !== "loss") continue;
    if (!GUARANTEE.grades.includes(e.grade) || e.net_minor === null) continue;
    verified += e.net_minor;
  }
  const fee = money(args.fee.amount_minor, currency);
  const ratio = fee.amount_minor === 0 ? null : ratioOf(money(verified, currency), fee);
  const base = {
    applies: true as const,
    closed_plans: closed,
    verified: money(verified, currency),
    fee,
    ratio_bp: ratio,
    threshold_bp: GUARANTEE.threshold_bp,
    other_currency_entries: otherCurrency,
  };
  if (closed < GUARANTEE.min_closed_plans) {
    return { ...base, outcome: "rolled_forward", credit: null };
  }
  // Integer comparison: verified × 10 000 ≥ fee × threshold_bp, no division.
  const met =
    BigInt(verified) * 10_000n >= BigInt(fee.amount_minor) * BigInt(GUARANTEE.threshold_bp);
  return met
    ? { ...base, outcome: "met", credit: null }
    : { ...base, outcome: "credit", credit: fee };
}
