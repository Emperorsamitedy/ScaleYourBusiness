// Pure helpers for the what-if pricing screen (idea 43): the words and
// picks the screen shows, testable without a browser. The arithmetic is
// lib/simulate/pricing.ts; this only words it.

import { minorUnitExponent } from "../../lib/core/money";
import type {
  BreakEven,
  PriceChange,
  PriceItemRaw,
  PricingInputs,
} from "../../lib/simulate/pricing";
import { PRICING, changeKey, periodWords, unitNoun } from "../../lib/simulate/pricing";
import { moneyText, num } from "../sheet/num";

/** Pure: the item the screen opens on — the most complete one, the first listed among equals. */
export function defaultItem(x: PricingInputs): PriceItemRaw | null {
  const score = (i: PriceItemRaw) =>
    (i.price ? 4 : 0) + (i.volume ? 2 : 0) + (i.unit_cost?.currency === i.currency ? 1 : 0);
  let best: PriceItemRaw | null = null;
  for (const i of x.items) if (best === null || score(i) > score(best)) best = i;
  return best;
}

/** The changes the screen opens on. */
export function defaultChanges(): PriceChange[] {
  return PRICING.default_steps.map((share) => ({ kind: "share", share }));
}

/** Pure: add or remove a step, holding the side by side to its maximum. */
export function toggleChange(picks: readonly PriceChange[], c: PriceChange): PriceChange[] {
  const key = changeKey(c);
  if (picks.some((p) => changeKey(p) === key)) return picks.filter((p) => changeKey(p) !== key);
  if (picks.length >= PRICING.max_changes) return [...picks];
  return [...picks, c];
}

/** "+10%" / "−5%" for a step button. */
export function stepLabel(share: number): string {
  const v = Math.round(Math.abs(share) * 100);
  return `${share > 0 ? "+" : "−"}${v}%`;
}

/** Pure: "36.50" in the item's major units → integer minor units, or null. */
export function exactToMinor(text: string, currency: string): number | null {
  const t = text.trim().replace(",", ".");
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const minor = Math.round(Number(t) * 10 ** minorUnitExponent(currency));
  return Number.isSafeInteger(minor) && minor > 0 ? minor : null;
}

export interface BreakEvenView {
  /** The cell's figure: "Lose fewer than 44". */
  figure: string;
  /** The line under it: "12.3% of ~350", "at least — no cost counted". */
  sub: string;
  flag: "MISSING" | "NEVER" | null;
}

/** Pure: the break-even as a side-by-side cell. A gap is a flag, never a number. */
export function breakEvenView(be: BreakEven, item: PriceItemRaw): BreakEvenView {
  const noun = unitNoun(item);
  const pct = (s: number) => `${num(s * 100, 1)}%`;
  const of = item.volume ? ` of ~${num(item.volume.value, 0)}` : " of your sales";
  switch (be.status) {
    case "lose": {
      const n = be.units === null ? null : Math.max(1, Math.ceil(be.units - 1e-9));
      return {
        figure: n === null ? `Lose fewer than ${pct(be.share)}` : `Lose fewer than ${num(n, 0)}`,
        sub: `${n === null ? noun : `${pct(be.share)}${of}`}${be.floor ? " · at least, whatever it costs you" : ""}`,
        flag: null,
      };
    }
    case "win": {
      const n = be.units === null ? null : Math.floor(be.units + 1e-9);
      const full = be.room !== null && be.units !== null && be.units >= be.room;
      return {
        figure: n === null ? `Win more than ${pct(be.share)}` : `Win more than ${num(n, 0)}`,
        sub: `${n === null ? `more ${noun}` : `+${pct(be.share)}${of}`}${full ? ` · the book has room for ${num(be.room!, 0)}` : ""}`,
        flag: null,
      };
    }
    case "never":
      return { figure: "Never pays", sub: "each one would lose money", flag: "NEVER" };
    case "missing":
      return { figure: "—", sub: be.needs.map((n) => n.what).join("; "), flag: "MISSING" };
  }
}

/** Pure: the item's line in the picker — what it costs, sells and is priced at. */
export function itemLine(i: PriceItemRaw): string {
  const parts: string[] = [];
  parts.push(i.price ? moneyText(i.price.amount_minor, i.currency) : "no price yet");
  parts.push(
    i.volume
      ? `~${num(i.volume.value, 0)} ${unitNoun(i)} ${periodWords(i)}`
      : `${unitNoun(i)} not known`,
  );
  parts.push(
    i.unit_cost && i.unit_cost.currency === i.currency
      ? `costs ${moneyText(i.unit_cost.amount_minor, i.currency)} to deliver`
      : "cost to deliver not known",
  );
  return parts.join(" · ");
}

/** Pure: the per-order costs in one sentence, or null — shown, never counted. */
export function perOrderLine(x: PricingInputs, item: PriceItemRaw | null): string | null {
  if (!item || item.kind !== "offer") return null;
  const same = x.per_order_costs.filter((c) => c.currency === item.currency);
  if (same.length === 0) return null;
  const list = same.map((c) => `${c.label} (${moneyText(c.amount_minor, c.currency)})`).join(", ");
  return `Not in the cost of one: ${list}. You pay ${same.length === 1 ? "it" : "them"} per order, not per piece, and an order can hold several pieces. Where one sale is one order, a rise can lose a few more sales than shown, and a cut needs a few more.`;
}
