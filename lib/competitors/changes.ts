// What changed since the last read of a competitor — feature 35.
//
// Pure. The stored observation (competitors.<id>.observed_offers) is
// superseded only when what was seen changed (rule 3), so the price
// history is the field's history; this module says, in words, what the
// difference between two consecutive observations was:
//   CHEAPER / DEARER — the same offer, the same currency, a new price;
//   NEW / GONE       — an offer that appeared, or vanished from a page
//                      that was read again (a page that couldn't be read
//                      this time keeps its old offers: not reading is not
//                      the same as gone);
//   CHANGED          — the same offer priced in a different currency,
//                      never converted (rule 1);
//   RATING           — the business-level rating moved by 0.1 or more.

import type { Money } from "../core/money";
import { moneyText } from "../../components/sheet/num";
import type { ExtractMethod, SeenOffer } from "./extract";

export interface ObservedOffer extends SeenOffer {
  /** The page it was seen on. */
  url: string;
  /** When that page was read. */
  fetched_at: string;
}

export interface ObservedOffers {
  /** One readable line: what the fact sheet and the diagnosis print. */
  label_raw: string;
  offers: ObservedOffer[];
}

export interface ObservedRating {
  label_raw: string;
  rating: number;
  best: number;
  count: number | null;
  url: string;
  method: ExtractMethod;
  fetched_at: string;
}

export type ChangeFlag = "CHEAPER" | "DEARER" | "NEW" | "GONE" | "CHANGED" | "RATING";

export interface CompetitorChange {
  flag: ChangeFlag;
  /** The offer's key; null for the rating. */
  key: string | null;
  sentence: string;
  before: Money | number | null;
  after: Money | number | null;
}

/** Most offers in one stored observation. */
export const MAX_OFFERS_PER_COMPETITOR = 80;

/** "Cut and colour" → "cut and colour"; "OPI Gel" stays as written. */
export function inSentence(name: string): string {
  return /^[A-Z][^A-Z]*$/.test(name) ? name.charAt(0).toLowerCase() + name.slice(1) : name;
}

const price = (o: { price: Money; from: boolean }): string =>
  `${o.from ? "from " : ""}${moneyText(o.price.amount_minor, o.price.currency)}`;

const ratingText = (r: { rating: number; best: number }): string =>
  `${Number.isInteger(r.rating) ? r.rating.toFixed(1) : String(r.rating)}${r.best === 5 ? "" : ` of ${r.best}`}`;

/** Pure: the readable line stored beside the offers. */
export function offersLabel(offers: readonly ObservedOffer[]): string {
  if (offers.length === 0) return "no prices seen on the pages read";
  const shown = offers.slice(0, 6).map((o) => `${o.name} ${price(o)}`);
  const more = offers.length > 6 ? `, and ${offers.length - 6} more` : "";
  return `${offers.length} price${offers.length === 1 ? "" : "s"} seen: ${shown.join(", ")}${more}`.slice(
    0,
    400,
  );
}

export function ratingLabel(r: { rating: number; best: number; count: number | null }): string {
  return `rated ${ratingText(r)}${r.best === 5 ? " of 5" : ""}${r.count !== null ? ` from ${r.count} reviews` : ""}`;
}

/** Pure: equal observations have equal signatures, whatever their read times. */
export function offersSignature(offers: readonly ObservedOffer[]): string {
  return offers
    .map((o) => `${o.key}|${o.price.amount_minor}|${o.price.currency}|${o.from ? 1 : 0}|${o.url}`)
    .sort()
    .join("\n");
}

export function ratingSignature(
  r: Pick<ObservedRating, "rating" | "best" | "count"> | null,
): string {
  return r === null ? "" : `${r.rating}|${r.best}|${r.count ?? ""}`;
}

/**
 * Pure: the changes between two observations of one competitor.
 * `freshUrls` are the pages read successfully this time — only an offer
 * from one of those can be GONE.
 */
export function detectChanges(args: {
  competitor: string;
  before: readonly ObservedOffer[];
  after: readonly ObservedOffer[];
  freshUrls: ReadonlySet<string>;
  ratingBefore: Pick<ObservedRating, "rating" | "best" | "count"> | null;
  ratingAfter: Pick<ObservedRating, "rating" | "best" | "count"> | null;
}): CompetitorChange[] {
  const out: CompetitorChange[] = [];
  const who = args.competitor;
  const was = new Map(args.before.map((o) => [o.key, o]));
  const now = new Map(args.after.map((o) => [o.key, o]));

  for (const o of args.after) {
    const old = was.get(o.key);
    const name = inSentence(o.name);
    if (!old) {
      out.push({
        flag: "NEW",
        key: o.key,
        sentence: `${who} now lists ${name} at ${price(o)}.`,
        before: null,
        after: o.price,
      });
      continue;
    }
    if (old.price.currency !== o.price.currency) {
      out.push({
        flag: "CHANGED",
        key: o.key,
        sentence: `${who} now prices ${name} at ${price(o)}; it was ${price(old)}.`,
        before: old.price,
        after: o.price,
      });
      continue;
    }
    if (old.price.amount_minor === o.price.amount_minor) continue;
    const cheaper = o.price.amount_minor < old.price.amount_minor;
    out.push({
      flag: cheaper ? "CHEAPER" : "DEARER",
      key: o.key,
      sentence: `${who} ${cheaper ? "cut" : "raised"} its ${name} price from ${price(old)} to ${price(o)}.`,
      before: old.price,
      after: o.price,
    });
  }

  for (const old of args.before) {
    if (now.has(old.key) || !args.freshUrls.has(old.url)) continue;
    out.push({
      flag: "GONE",
      key: old.key,
      sentence: `${who} no longer lists ${inSentence(old.name)} (it was ${price(old)}).`,
      before: old.price,
      after: null,
    });
  }

  const a = args.ratingBefore;
  const b = args.ratingAfter;
  if (
    a &&
    b &&
    a.best === b.best &&
    Math.abs(Math.round(a.rating * 100) - Math.round(b.rating * 100)) >= 10
  ) {
    out.push({
      flag: "RATING",
      key: null,
      sentence: `${who}'s rating moved from ${ratingText(a)} to ${ratingText(b)}${b.count !== null ? ` (${b.count} reviews)` : ""}.`,
      before: a.rating,
      after: b.rating,
    });
  }
  return out;
}
