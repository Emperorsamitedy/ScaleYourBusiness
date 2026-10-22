// The cheapest ways to clear slow stock — feature 34. Pure module.
//
// Five candidates, cheapest first, each with its scenario (cash likely
// recovered as a range, the worst case, what it costs), its reversibility
// and its evidence (the item's own numbers):
//
//   content   feature it in a post on a channel the owner already runs
//   bundle    pair it with a best seller that has stock, both at full price
//   email     one email to the customers who said yes to email, through
//             the consent-gated campaign path (P4-14/15)
//   markdown  a price cut — only where the owner's standing rules allow
//             discounts (rule 14: a "never discount" blocks it, visibly)
//   selloff   sell it off to a clearance buyer or return it to the
//             supplier — advice only: nothing contacts anyone
//
// "Most efficient" is the most cash likely back once what it gives up is
// paid for: expected recovered minus expected cost or margin given up, with
// the arithmetic shown. Cash per euro given up is shown beside it and breaks
// ties (an option giving nothing up beats any ratio). Ranking free options
// first regardless of size put a ~€44 email above a ~€12,600 markdown —
// efficient per euro, useless for the stock. The rates below are ASSUMPTIONS, pinned here and stated
// on every proposal as assumptions with high sensitivity — nobody measured
// how a post moves a mug. The readback (P3-25) will, once options run.

import type { ActionKind } from "../proposals/hard-limits";
import type { Reversibility } from "../proposals/service";
import type { StockItem } from "./assess";

export const CLEARANCE = {
  /** Share of the stock on hand a post featuring it is assumed to sell, at full price. */
  content_sell_through: [0.05, 0.15],
  /** Share a pairing with a best seller is assumed to sell, capped by the best seller's own stock. */
  bundle_sell_through: [0.1, 0.25],
  /** Share of emailed customers assumed to buy one. */
  email_buy_rate: [0.01, 0.03],
  /** The markdown's cut, off the current price. */
  markdown_share: 0.25,
  /** Share a markdown is assumed to sell. */
  markdown_sell_through: [0.3, 0.6],
  /** What a clearance buyer or a supplier return is assumed to pay, as a share of cost. */
  selloff_recovery_of_cost: [0.2, 0.4],
  /** Proposals are made for this many items, most cash tied up first. */
  max_items: 3,
  expiry_days: 14,
} as const;

export type OptionKey = "content" | "bundle" | "email" | "markdown" | "selloff";
export const OPTION_ORDER: readonly OptionKey[] = [
  "content",
  "bundle",
  "email",
  "markdown",
  "selloff",
];

export const OPTION_KIND: Readonly<Record<OptionKey, ActionKind>> = {
  content: "content_publishing",
  bundle: "offer_change",
  email: "customer_email",
  markdown: "discount_or_promotion",
  selloff: "operations_change",
};

export const OPTION_LABEL: Readonly<Record<OptionKey, string>> = {
  content: "Feature it in a post",
  bundle: "Pair it with a best seller",
  email: "Email customers who said yes",
  markdown: "Mark it down",
  selloff: "Sell it off or send it back",
};

export interface Range {
  low: number;
  high: number;
  /** The midpoint, rounded: what the ranking uses. */
  expected: number;
}

export interface ClearanceOption {
  key: OptionKey;
  kind: ActionKind;
  label: string;
  /** Null when it can be proposed; otherwise why not, in words. */
  unavailable: string | null;
  units: Range;
  /** Cash likely recovered, in the item's currency. */
  recovered: Range;
  /** Cost, or margin given up against selling at full price. */
  given_up: Range;
  /** Expected recovered ÷ expected given up; null when nothing is given up. */
  per_euro: number | null;
  worst_case: string;
  /** The arithmetic, with the real numbers in it. */
  arithmetic: string;
  reversibility: Reversibility;
}

/** What the options need beyond the item itself. */
export interface OptionContext {
  /** A best seller with stock to pair with: its name and units on hand. */
  best_seller: { name: string; on_hand: number } | null;
  /** The channel a post would go on, when the owner runs one. */
  content_channel: string | null;
  /** Customers an email could go to: explicit consent, not suppressed. */
  emailable: number;
  /** Why email is off, when it is (the owner's 6.4b answer). */
  email_off: string | null;
  /** Formats minor units in the item's currency, for the arithmetic lines. */
  fmt: (minor: number) => string;
}

const range = (low: number, high: number): Range => ({
  low,
  high,
  expected: Math.round((low + high) / 2),
});

const ZERO = range(0, 0);

function unitsOf(q: number, [lo, hi]: readonly [number, number], cap = q): Range {
  const max = Math.min(q, cap);
  return range(Math.min(max, Math.floor(q * lo)), Math.min(max, Math.ceil(q * hi)));
}

/** Pure: the five options for one item, unranked, with their arithmetic. */
export function clearanceOptions(item: StockItem, ctx: OptionContext): ClearanceOption[] {
  const q = item.on_hand;
  const atPrice = item.value_at_price;
  const atCost = item.value_at_cost;
  // Recovered cash for u units at full price, from the value at price (no per-unit rounding drift).
  const full = (u: number) => (atPrice === null || q === 0 ? 0 : Math.round((atPrice * u) / q));
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  const noPrice = atPrice === null ? "its selling price isn't known" : null;
  const { fmt } = ctx;
  const make = (
    key: OptionKey,
    o: Omit<ClearanceOption, "key" | "kind" | "label" | "per_euro">,
  ): ClearanceOption => ({
    key,
    kind: OPTION_KIND[key],
    label: OPTION_LABEL[key],
    ...o,
    per_euro: o.given_up.expected > 0 ? o.recovered.expected / o.given_up.expected : null,
  });

  const out: ClearanceOption[] = [];

  // (a) content
  {
    const units = unitsOf(q, CLEARANCE.content_sell_through);
    const recovered = range(full(units.low), full(units.high));
    out.push(
      make("content", {
        unavailable:
          noPrice ?? (ctx.content_channel === null ? "you don't run a channel to post on" : null),
        units,
        recovered,
        given_up: ZERO,
        worst_case: "Nothing sells from the post; it cost your review time and nothing else.",
        arithmetic: `${q} on hand × ${pct(CLEARANCE.content_sell_through[0])}–${pct(CLEARANCE.content_sell_through[1])} sold at full price = ${units.low}–${units.high} units, ${fmt(recovered.low)}–${fmt(recovered.high)}; nothing given up`,
        reversibility: {
          level: "easy",
          if_you_change_your_mind:
            "A draft is a draft: delete it. Nothing is posted until you approve the finished post.",
        },
      }),
    );
  }

  // (b) bundle
  {
    const bs = ctx.best_seller;
    const units = unitsOf(q, CLEARANCE.bundle_sell_through, bs?.on_hand ?? 0);
    const recovered = range(full(units.low), full(units.high));
    out.push(
      make("bundle", {
        unavailable: noPrice ?? (bs === null ? "no best seller with stock to pair it with" : null),
        units,
        recovered,
        given_up: ZERO,
        worst_case:
          "Nobody takes the pair; you take it down and both sell as they did, at full price.",
        arithmetic:
          bs === null
            ? "no best seller with stock on hand to pair it with"
            : `${q} on hand × ${pct(CLEARANCE.bundle_sell_through[0])}–${pct(CLEARANCE.bundle_sell_through[1])}, capped at ${bs.on_hand} ${bs.name} on hand = ${units.low}–${units.high} units, ${fmt(recovered.low)}–${fmt(recovered.high)}; both at full price, nothing given up`,
        reversibility: {
          level: "easy",
          if_you_change_your_mind:
            "Take the pairing down in your shop. I don't change your shop: you set it up, and undo it, yourself.",
        },
      }),
    );
  }

  // (c) email
  {
    const n = ctx.emailable;
    const units = range(
      Math.min(q, Math.floor(n * CLEARANCE.email_buy_rate[0])),
      Math.min(q, Math.ceil(n * CLEARANCE.email_buy_rate[1])),
    );
    const recovered = range(full(units.low), full(units.high));
    out.push(
      make("email", {
        unavailable:
          noPrice ?? ctx.email_off ?? (n === 0 ? "no customer has said yes to email yet" : null),
        units,
        recovered,
        given_up: ZERO,
        worst_case: "Nobody buys, and a few unsubscribe — honoured at once and for good.",
        arithmetic: `${n} customers who said yes to email × ${pct(CLEARANCE.email_buy_rate[0])}–${pct(CLEARANCE.email_buy_rate[1])} buying one, capped at ${q} on hand = ${units.low}–${units.high} units, ${fmt(recovered.low)}–${fmt(recovered.high)}; no discount, nothing given up`,
        reversibility: {
          level: "hard",
          if_you_change_your_mind:
            "Irreversible once sent: a sent email can't be recalled. Until then, decline it, don't approve the email itself, or press the emergency stop.",
        },
      }),
    );
  }

  // (d) markdown
  {
    const units = unitsOf(q, CLEARANCE.markdown_sell_through);
    const cut = CLEARANCE.markdown_share;
    const at = (u: number) => Math.round(full(u) * (1 - cut));
    const recovered = range(at(units.low), at(units.high));
    const given_up = range(full(units.low) - at(units.low), full(units.high) - at(units.high));
    out.push(
      make("markdown", {
        unavailable: noPrice,
        units,
        recovered,
        given_up,
        worst_case:
          "Few sell even marked down, and regular customers learn to wait for the next one.",
        arithmetic: `${q} on hand × ${pct(CLEARANCE.markdown_sell_through[0])}–${pct(CLEARANCE.markdown_sell_through[1])} sold at ${pct(cut)} off = ${units.low}–${units.high} units, ${fmt(recovered.low)}–${fmt(recovered.high)}, giving up ${fmt(given_up.low)}–${fmt(given_up.high)} of the full price`,
        reversibility: {
          level: "moderate",
          if_you_change_your_mind:
            "Put the price back in your shop; what sold at the lower price stays sold. I don't change your prices: you do.",
        },
      }),
    );
  }

  // (e) sell off or return — advice only
  {
    const [lo, hi] = CLEARANCE.selloff_recovery_of_cost;
    const recovered =
      atCost === null ? ZERO : range(Math.round(atCost * lo), Math.round(atCost * hi));
    const given_up =
      atPrice === null
        ? ZERO
        : range(Math.max(0, atPrice - recovered.high), Math.max(0, atPrice - recovered.low));
    out.push(
      make("selloff", {
        unavailable: atCost === null ? "what it cost you isn't known" : noPrice,
        units: range(q, q),
        recovered,
        given_up,
        worst_case:
          "No buyer or supplier takes it, or only at less than this; the stock stays where it is.",
        arithmetic:
          atCost === null
            ? "no cost on record to value it at"
            : `${fmt(atCost)} at cost × ${pct(lo)}–${pct(hi)} = ${fmt(recovered.low)}–${fmt(recovered.high)}, giving up ${fmt(given_up.low)}–${fmt(given_up.high)} against ${fmt(atPrice ?? 0)} at full price`,
        reversibility: {
          level: "hard",
          if_you_change_your_mind:
            "Advice only: I contact nobody. Once you sell it off or send it back, it's gone.",
        },
      }),
    );
  }
  return out;
}

/**
 * Pure: the ranking. Proposable options first; among them, by net cash
 * likely back (recovered − given up, expected values), most first; ties by
 * cash back per unit given up (nothing given up counts as best), then the
 * cheapest-first candidate order. Options that can't be proposed go last,
 * in candidate order.
 */
export function netBack(o: ClearanceOption): number {
  return o.recovered.expected - o.given_up.expected;
}

export function rankOptions(options: readonly ClearanceOption[]): ClearanceOption[] {
  const order = (o: ClearanceOption) => OPTION_ORDER.indexOf(o.key);
  const ratio = (o: ClearanceOption) => (o.per_euro === null ? Infinity : o.per_euro);
  return [...options].sort((a, b) => {
    const ua = a.unavailable === null ? 0 : 1;
    const ub = b.unavailable === null ? 0 : 1;
    if (ua !== ub) return ua - ub;
    if (ua === 1) return order(a) - order(b);
    if (netBack(a) !== netBack(b)) return netBack(b) - netBack(a);
    if (ratio(a) !== ratio(b)) return ratio(b) > ratio(a) ? 1 : -1;
    return order(a) - order(b);
  });
}

/** Pure: the ranking's own sentence for one option. */
export function efficiencyLine(o: ClearanceOption, fmt: (minor: number) => string): string {
  if (o.per_euro === null) {
    return `${fmt(o.recovered.expected)} likely back, nothing given up`;
  }
  return `${fmt(o.recovered.expected)} likely back − ${fmt(o.given_up.expected)} given up = ${fmt(netBack(o))} net (${o.per_euro.toFixed(2)} back for every 1 given up)`;
}
