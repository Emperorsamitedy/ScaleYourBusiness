// "I don't know" becomes a priced question — the v1 build spec §6.3 (P7-51).
//
// Every gap gets:
//   unlock_value_range  what answering it would reveal or recover
//   unlock_method       connect X, upload Y, or count Z once
//   effort              minutes
// ranked by unlock value ÷ effort; the top three are the first week.
//
// The value is never invented: it is the money at stake in the report's own
// recommendations that rest on the gap's fact — their scenario ranges,
// summed per currency. A gap nothing rests on carries no money, and ranks
// by effort alone after the priced ones. Method and effort are data
// (specs/gap-unlocks-v1.json), matched by the fact key's prefix.

import unlocks from "../../specs/gap-unlocks-v1.json";
import type { Money } from "../core/money";

export interface UnlockRule {
  prefix: string;
  method: "connect" | "upload" | "count";
  /** What to connect, upload or count, in plain words. */
  what: string;
  effort_minutes: number;
}

export const UNLOCK_RULES: readonly UnlockRule[] = (unlocks as { rules: UnlockRule[] }).rules;
const FALLBACK: UnlockRule = {
  prefix: "",
  method: "count",
  what: "answer it once",
  effort_minutes: 2,
};

export function unlockRuleFor(fieldKey: string): UnlockRule {
  let best: UnlockRule | null = null;
  for (const r of UNLOCK_RULES) {
    if (fieldKey.startsWith(r.prefix) && (!best || r.prefix.length > best.prefix.length)) best = r;
  }
  return best ?? FALLBACK;
}

export interface GapInput {
  question_id: string;
  field_key: string;
  prompt: string;
}

export interface RecommendationStake {
  /** The fact keys the recommendation's evidence cites. */
  cites: readonly string[];
  low: Money | null;
  high: Money | null;
}

export interface PricedGap extends GapInput {
  unlock_value_range: { low: Money; high: Money }[];
  unlock_method: UnlockRule["method"];
  unlock_what: string;
  effort_minutes: number;
  /** The first three are the owner's first week. */
  first_week: boolean;
}

/** Pure: price, rank and mark the first week. */
export function priceGaps(
  gaps: readonly GapInput[],
  stakes: readonly RecommendationStake[],
): PricedGap[] {
  const priced = gaps.map((g) => {
    const rule = unlockRuleFor(g.field_key);
    const sums = new Map<string, { low: number; high: number }>();
    for (const s of stakes) {
      if (!s.cites.includes(g.field_key) || !s.low || !s.high || s.low.currency !== s.high.currency)
        continue;
      const held = sums.get(s.low.currency) ?? { low: 0, high: 0 };
      held.low += Math.max(0, s.low.amount_minor);
      held.high += Math.max(0, s.high.amount_minor);
      sums.set(s.low.currency, held);
    }
    return {
      ...g,
      unlock_value_range: [...sums].map(([currency, r]) => ({
        low: { amount_minor: r.low, currency },
        high: { amount_minor: r.high, currency },
      })),
      unlock_method: rule.method,
      unlock_what: rule.what,
      effort_minutes: rule.effort_minutes,
      first_week: false,
    };
  });
  // Value per minute, in each gap's first currency; unpriced gaps after, quickest first.
  const valueOf = (p: PricedGap) => p.unlock_value_range[0]?.high.amount_minor ?? -1;
  priced.sort((a, b) => {
    const va = valueOf(a);
    const vb = valueOf(b);
    if (va < 0 || vb < 0)
      return va < 0 && vb < 0 ? a.effort_minutes - b.effort_minutes : va < 0 ? 1 : -1;
    // va/a.effort vs vb/b.effort, compared without dividing.
    return vb * a.effort_minutes - va * b.effort_minutes;
  });
  priced.slice(0, 3).forEach((p) => (p.first_week = true));
  return priced;
}
