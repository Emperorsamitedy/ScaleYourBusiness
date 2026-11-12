// Subscription tiers — the v1 build spec §8.3 (P7-71).
//
//   Watch       €49/mo   station 2
//   Act         €149/mo  station 3
//   Autonomous  €299/mo  station 4, and the §8.4 guarantee
//   Extra business €29/mo each, on the same tier as its parent
//
// The amounts are the price book's (lib/billing/price-book), per market,
// never constants here. Annual billing is 12 months at 20 % off, rounded to
// the currency's price step (HUF: 500 Ft) — integer arithmetic only. The
// ladder ceiling per tier is lib/ladder/ladder.ts's TIER_CEILING (D49).

import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import { subscriptions } from "../../db/schema";
import { roundPrice } from "../core/currency-table";
import { scaleMinorBy } from "../core/money";
import { TIER_CEILING } from "../ladder/ladder";
import type { Tier } from "./price-book";
import { resolvePrice } from "./price-book";

export const SUBSCRIPTION_TIERS = ["watch", "act", "autonomous"] as const;
export type SubscriptionTier = (typeof SUBSCRIPTION_TIERS)[number];
export type Interval = "month" | "year";

/** §8.3: annual billing at 20 % off, in basis points of 12 months. */
export const ANNUAL_DISCOUNT_BP = 2_000;

export function isSubscriptionTier(t: string): t is SubscriptionTier {
  return (SUBSCRIPTION_TIERS as readonly string[]).includes(t);
}

/** Pure: one period's amount — a month as listed, or a year at 20 % off, on the price step. */
export function periodAmount(monthlyMinor: number, currency: string, interval: Interval): number {
  if (interval === "month") return monthlyMinor;
  return roundPrice(scaleMinorBy(monthlyMinor * 12, 10_000 - ANNUAL_DISCOUNT_BP, 10_000), currency);
}

export interface PlanPrice {
  tier: SubscriptionTier | "extra_business";
  currency: string;
  monthly_minor: number;
  yearly_minor: number;
  /** The ladder station this tier reaches (§8.3); null for an extra business (its parent's). */
  ceiling: number | null;
  /** §8.4: only Autonomous carries the guarantee — said plainly, not buried. */
  guarantee: boolean;
}

/** Every tier's price for a billing country today, from the price book. */
export async function planPrices(country: string, now = new Date()): Promise<PlanPrice[]> {
  const day = now.toISOString().slice(0, 10);
  const out: PlanPrice[] = [];
  for (const tier of [...SUBSCRIPTION_TIERS, "extra_business"] as const) {
    const row = await resolvePrice(tier as Tier, country, day);
    out.push({
      tier,
      currency: row.currency,
      monthly_minor: row.list_amount_minor,
      yearly_minor: periodAmount(row.list_amount_minor, row.currency, "year"),
      ceiling: tier === "extra_business" ? null : (TIER_CEILING[tier] ?? null),
      guarantee: tier === "autonomous",
    });
  }
  return out;
}

/**
 * §8.3: an extra business is "same tier as parent". Its ladder ceiling is
 * its parent's live tier; with no live parent it has none of its own.
 */
export async function extraBusinessTier(
  parentSubscriptionId: string,
): Promise<SubscriptionTier | null> {
  const [parent] = await db
    .select({ tier: subscriptions.tier })
    .from(subscriptions)
    .where(and(eq(subscriptions.id, parentSubscriptionId), eq(subscriptions.status, "active")));
  return parent && isSubscriptionTier(parent.tier) ? parent.tier : null;
}
