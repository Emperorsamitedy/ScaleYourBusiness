// Bought together — idea 48, bundles. Pure: no database, no model.
//
// Market-basket arithmetic over the business's own orders (or, for a
// bookings business, its visits: one client's completed appointments on
// one day). For every pair of items that shared a basket:
//
//   together    baskets holding both
//   support     together ÷ all baskets
//   confidence  together ÷ baskets holding A — "X% of orders with A also
//               had B". A is the rarer of the two, so it is the stronger
//               direction ("most pour-over sets go out with a vase", not
//               "a few vases go out with a pour-over set")
//   lift        together ÷ what chance alone would give (count A × count
//               B ÷ baskets). 1.0 is chance; below it, the two avoid each
//               other
//
// Noise is not shown. A pair counts only when it shared at least
// BUNDLES.min_together baskets AND came up at least BUNDLES.min_lift times
// as often as chance; and nothing is mined from fewer than
// BUNDLES.min_baskets baskets, because a handful of orders can make any
// two items look inseparable. What was left out is counted, never hidden.

export const BUNDLES = {
  /** Fewer baskets than this and pairs aren't mined: chance would dominate. */
  min_baskets: 50,
  /** A pair must have shared at least this many baskets… */
  min_together: 5,
  /** …and come up at least this many times as often as chance. */
  min_lift: 1.2,
  /** Pairs shown, most often together first. */
  max_pairs: 5,
  /** How far back baskets are read. */
  window_days: 365,
} as const;

export interface Basket {
  /** Distinct item ids. Duplicates are ignored. */
  items: readonly string[];
}

export interface PairStat {
  /** The rarer item — the "with A" of "X% of orders with A". */
  a: string;
  b: string;
  together: number;
  count_a: number;
  count_b: number;
  baskets: number;
  support: number;
  /** together ÷ count_a. */
  confidence: number;
  /** together ÷ count_b. */
  confidence_ba: number;
  lift: number;
  /** What chance alone would give: count_a × count_b ÷ baskets. */
  expected: number;
}

export type PairsResult =
  | {
      status: "too_few";
      baskets: number;
      /** Baskets holding two items or more: the only ones a pair can come from. */
      multi: number;
      needed: number;
    }
  | {
      status: "mined";
      baskets: number;
      multi: number;
      /** The pairs shown, most often together first. */
      pairs: PairStat[];
      /** Pairs that passed both thresholds, before the max_pairs cut. */
      passed: number;
      /** Distinct pairs seen together at all. */
      seen: number;
      /** Seen, but in fewer than min_together baskets. */
      below_count: number;
      /** Often enough, but no more often than chance would give. */
      below_lift: number;
    };

export interface PairThresholds {
  min_baskets: number;
  min_together: number;
  min_lift: number;
  max_pairs: number;
}

const key = (a: string, b: string) => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`);

export function minePairs(baskets: readonly Basket[], t: PairThresholds = BUNDLES): PairsResult {
  const counts = new Map<string, number>();
  const together = new Map<string, number>();
  let n = 0;
  let multi = 0;
  for (const basket of baskets) {
    const items = [...new Set(basket.items)].sort();
    if (items.length === 0) continue;
    n++;
    if (items.length > 1) multi++;
    for (const item of items) counts.set(item, (counts.get(item) ?? 0) + 1);
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const k = key(items[i]!, items[j]!);
        together.set(k, (together.get(k) ?? 0) + 1);
      }
    }
  }
  if (n < t.min_baskets) return { status: "too_few", baskets: n, multi, needed: t.min_baskets };

  let belowCount = 0;
  let belowLift = 0;
  const passed: PairStat[] = [];
  for (const [k, both] of together) {
    const [x, y] = k.split("\u0000") as [string, string];
    const cx = counts.get(x)!;
    const cy = counts.get(y)!;
    // A is the rarer item; a tie goes to the id that sorts first.
    const [a, b, ca, cb] = cx <= cy ? [x, y, cx, cy] : [y, x, cy, cx];
    const expected = (ca * cb) / n;
    const lift = both / expected;
    if (both < t.min_together) {
      belowCount++;
      continue;
    }
    if (lift < t.min_lift) {
      belowLift++;
      continue;
    }
    passed.push({
      a,
      b,
      together: both,
      count_a: ca,
      count_b: cb,
      baskets: n,
      support: both / n,
      confidence: both / ca,
      confidence_ba: both / cb,
      lift,
      expected,
    });
  }
  passed.sort(
    (p, q) => q.together - p.together || q.lift - p.lift || (p.a + p.b < q.a + q.b ? -1 : 1),
  );
  return {
    status: "mined",
    baskets: n,
    multi,
    pairs: passed.slice(0, t.max_pairs),
    passed: passed.length,
    seen: together.size,
    below_count: belowCount,
    below_lift: belowLift,
  };
}

/** A bookings business's baskets: one client's completed appointments on one day. */
export interface VisitAppointment {
  day: string;
  client_key: string | null;
  service: string | null;
  status: string;
}

export function visitsOf(appointments: readonly VisitAppointment[]): {
  visits: Basket[];
  /** Completed appointments with no client or no service: they can't be grouped into a visit. */
  ungrouped: number;
} {
  const byVisit = new Map<string, Set<string>>();
  let ungrouped = 0;
  for (const a of appointments) {
    if (a.status !== "completed") continue;
    const service = a.service?.trim() ?? "";
    if (a.client_key === null || service === "") {
      ungrouped++;
      continue;
    }
    const k = `${a.client_key}|${a.day}`;
    const set = byVisit.get(k) ?? new Set<string>();
    set.add(service);
    byVisit.set(k, set);
  }
  return { visits: [...byVisit.values()].map((s) => ({ items: [...s] })), ungrouped };
}

/** One item's own economics, from the owner's offers (price and cost), when known. */
export interface ItemEconomics {
  price_minor: number;
  /** Null when no cost is recorded: the margin is then unknown, never assumed. */
  cost_minor: number | null;
  currency: string;
}

export type PairMargin =
  | {
      known: true;
      currency: string;
      price_minor: number;
      contribution_minor: number;
      /** Percentage points, one decimal. */
      margin_pct: number;
      formula: string;
    }
  | { known: false; why: string };

/** The pair's margin, from each item's price and cost: arithmetic, or an honest "unknown". */
export function pairMargin(
  a: { name: string; economics: ItemEconomics | null },
  b: { name: string; economics: ItemEconomics | null },
): PairMargin {
  const missing = [a, b].filter((x) => x.economics === null).map((x) => x.name);
  if (missing.length > 0) {
    return { known: false, why: `no price on record for ${missing.join(" or ")}` };
  }
  const ea = a.economics!;
  const eb = b.economics!;
  if (ea.currency !== eb.currency) {
    return { known: false, why: "their prices are in different currencies" };
  }
  const noCost = [a, b].filter((x) => x.economics!.cost_minor === null).map((x) => x.name);
  if (noCost.length > 0) {
    return {
      known: false,
      why: `no cost on record for ${noCost.join(" or ")}, so the margin is unknown rather than assumed`,
    };
  }
  const price = ea.price_minor + eb.price_minor;
  const contribution = price - ea.cost_minor! - eb.cost_minor!;
  return {
    known: true,
    currency: ea.currency,
    price_minor: price,
    contribution_minor: contribution,
    margin_pct: price > 0 ? Math.round((contribution / price) * 1000) / 10 : 0,
    formula: `(${a.name} price − cost) + (${b.name} price − cost), over both prices`,
  };
}
