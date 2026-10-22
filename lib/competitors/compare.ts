// Their price beside yours — feature 35.
//
// Pure and deterministic. A competitor's offer is matched to one of the
// owner's own offers by, in order:
//   1. the owner's own correction (competitors.<id>.offer_matches);
//   2. the name: the same words, or at least half of them shared;
//   3. the category: both names fall in the same row of CATEGORIES.
// Then the gap is arithmetic on integer minor units in ONE currency. A
// competitor priced in another currency is shown, never converted
// (rule 1). The result is evidence for the owner to read; nothing here,
// or anywhere downstream of it, changes a price (rule 12).

import type { Money } from "../core/money";
import { moneyText } from "../../components/sheet/num";
import { offerKey } from "./extract";

export interface OwnOffer {
  id: string;
  name: string;
  price: Money | null;
}

/** The deterministic category table. Order matters: the first row a name hits wins. */
export const CATEGORIES: readonly { code: string; words: readonly string[] }[] = [
  {
    code: "colour",
    words: ["color", "tint", "highlights", "balayage", "ombre", "toner", "roots", "foils"],
  },
  { code: "haircut", words: ["cut", "haircut", "trim", "fringe", "clipper"] },
  { code: "blow_dry", words: ["blow dry", "blowdry", "blow out", "styling", "updo"] },
  { code: "treatment", words: ["keratin", "olaplex", "treatment", "perm", "straightening"] },
  { code: "nails", words: ["manicure", "pedicure", "gel", "nails", "shellac", "acrylic"] },
  { code: "lashes", words: ["lash", "lashes", "eyelash"] },
  { code: "brows", words: ["brow", "brows", "eyebrow"] },
  { code: "waxing", words: ["wax", "waxing"] },
  { code: "facial", words: ["facial", "peel", "microdermabrasion"] },
  { code: "massage", words: ["massage"] },
  { code: "beard", words: ["beard", "shave"] },
];

const STOP = new Set(["and", "with", "the", "a", "an", "for", "of", "in", "our", "your", "s"]);

function tokens(name: string): Set<string> {
  return new Set(
    offerKey(name)
      .split(" ")
      .filter((t) => t !== "" && !STOP.has(t)),
  );
}

/** Pure: shared words over all words (Jaccard), 0–1. */
export function similarity(a: string, b: string): number {
  const x = tokens(a);
  const y = tokens(b);
  if (x.size === 0 || y.size === 0) return 0;
  let shared = 0;
  for (const t of x) if (y.has(t)) shared++;
  return shared / (x.size + y.size - shared);
}

/** Pure: the category row a name falls in, or null. */
export function categoryOf(name: string): string | null {
  const key = ` ${offerKey(name)} `;
  for (const row of CATEGORIES) {
    if (row.words.some((w) => key.includes(` ${w} `))) return row.code;
  }
  return null;
}

export type MatchBasis = "owner" | "name" | "category";

/** The share of words at which two names count as the same offer. */
export const NAME_MATCH_AT = 0.5;

/**
 * Pure: the owner's offer this competitor offer compares with. A
 * correction of "none" means the owner said nothing of theirs compares.
 */
export function matchOffer(
  theirs: { name: string },
  own: readonly OwnOffer[],
  correction?: string,
): { offer: OwnOffer; basis: MatchBasis } | null {
  if (correction === "none") return null;
  if (correction !== undefined) {
    const chosen = own.find((o) => o.id === correction);
    if (chosen) return { offer: chosen, basis: "owner" };
  }
  let best: { offer: OwnOffer; score: number } | null = null;
  for (const o of own) {
    const score = offerKey(o.name) === offerKey(theirs.name) ? 1 : similarity(o.name, theirs.name);
    if (score >= NAME_MATCH_AT && (!best || score > best.score)) best = { offer: o, score };
  }
  if (best) return { offer: best.offer, basis: "name" };
  const category = categoryOf(theirs.name);
  if (category === null) return null;
  const same = own.filter((o) => categoryOf(o.name) === category);
  if (same.length === 0) return null;
  const pick = same.reduce((a, b) =>
    similarity(b.name, theirs.name) > similarity(a.name, theirs.name) ? b : a,
  );
  return { offer: pick, basis: "category" };
}

export interface PriceGap {
  /** Theirs minus yours, in minor units of the shared currency. */
  diff_minor: number;
  /** Rounded whole percent of yours; null when yours is zero. */
  percent: number | null;
  currency: string;
  words: string;
}

/** Pure: their price against yours, or null when the currencies differ (never converted). */
export function priceGap(theirs: Money, yours: Money): PriceGap | null {
  if (theirs.currency !== yours.currency) return null;
  const diff = theirs.amount_minor - yours.amount_minor;
  const percent =
    yours.amount_minor === 0
      ? null
      : Math.sign(diff) * Math.round((Math.abs(diff) * 100) / yours.amount_minor);
  const amount = moneyText(Math.abs(diff), theirs.currency);
  const pct =
    percent === null || percent === 0 ? "" : ` (${percent > 0 ? "+" : "−"}${Math.abs(percent)}%)`;
  const words =
    diff === 0 ? "the same as yours" : `${amount} ${diff < 0 ? "below" : "above"} yours${pct}`;
  return { diff_minor: diff, percent, currency: theirs.currency, words };
}
