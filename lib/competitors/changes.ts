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
import { moneyText, num } from "../../components/sheet/num";
import type { AppLocale } from "../i18n/locales";
import { intlTag } from "../i18n/locales";
import type { Tr } from "../i18n/tr";
import { englishTr } from "../i18n/tr";
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
  /** What the sentence is made of, so the screen can say it in another language (L-4b). */
  facts: ChangeFacts;
}

/** A seen price: the amount, and whether the page said "from". */
export interface SeenPrice {
  price: Money;
  from: boolean;
}

/**
 * A change's parts, stored beside its English sentence (watch_activity
 * meta): the competitor's and the offer's names as seen (content, never
 * translated), the prices, the ratings.
 */
export interface ChangeFacts {
  who: string;
  /** The offer's name as the page wrote it; null for the rating. */
  name: string | null;
  before: SeenPrice | null;
  after: SeenPrice | null;
  rating_before?: { rating: number; best: number } | null;
  rating_after?: { rating: number; best: number; count: number | null } | null;
}

/** The words a change is said in: the "competitorsWords" catalogue and the reader's locale. */
export interface CompetitorWords {
  tr: Tr;
  locale: AppLocale;
}

export const englishCompetitorWords = (): CompetitorWords => ({
  tr: englishTr("competitorsWords"),
  locale: "en",
});

/** "from €45", "€45" — in the reader's words and digits. */
export function priceIn(o: SeenPrice, { tr, locale }: CompetitorWords): string {
  const amount = moneyText(o.price.amount_minor, o.price.currency, locale);
  return o.from ? tr("price.from", { amount }) : amount;
}

/** "4.8", "4.5 of 10" — in the reader's words and digits. */
export function ratingIn(r: { rating: number; best: number }, { tr, locale }: CompetitorWords) {
  const rating =
    locale === "en"
      ? Number.isInteger(r.rating)
        ? r.rating.toFixed(1)
        : String(r.rating)
      : new Intl.NumberFormat(intlTag(locale), {
          minimumFractionDigits: 1,
          maximumFractionDigits: 2,
        }).format(r.rating);
  if (r.best === 5) return rating;
  return tr("rating.of", {
    rating,
    best: locale === "en" ? String(r.best) : num(r.best, 0, locale),
  });
}

/** A change's sentence, from its parts — English (what is stored) unless other words are given. */
export function changeSentence(
  flag: ChangeFlag,
  f: ChangeFacts,
  w: CompetitorWords = englishCompetitorWords(),
): string {
  const { tr, locale } = w;
  const who = f.who;
  const name = f.name === null ? "" : locale === "en" ? inSentence(f.name) : f.name;
  const before = f.before ? priceIn(f.before, w) : "";
  const price = f.after ? priceIn(f.after, w) : "";
  switch (flag) {
    case "NEW":
      return tr("change.new", { who, name, price });
    case "CHANGED":
      return tr("change.changed", { who, name, price, before });
    case "CHEAPER":
      return tr("change.cheaper", { who, name, price, before });
    case "DEARER":
      return tr("change.dearer", { who, name, price, before });
    case "GONE":
      return tr("change.gone", { who, name, before });
    case "RATING": {
      const a = f.rating_before ? ratingIn(f.rating_before, w) : "";
      const b = f.rating_after ? ratingIn(f.rating_after, w) : "";
      const count = f.rating_after?.count ?? null;
      if (count === null) return tr("change.rating", { who, before: a, after: b });
      return tr("change.ratingCount", {
        who,
        before: a,
        after: b,
        count,
        reviews: locale === "en" ? String(count) : num(count, 0, locale),
      });
    }
  }
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

  const seen = (o: ObservedOffer): SeenPrice => ({ price: o.price, from: o.from });
  const change = (flag: ChangeFlag, key: string | null, facts: ChangeFacts): CompetitorChange => ({
    flag,
    key,
    sentence: changeSentence(flag, facts),
    before: facts.before?.price ?? null,
    after: facts.after?.price ?? null,
    facts,
  });

  for (const o of args.after) {
    const old = was.get(o.key);
    if (!old) {
      out.push(change("NEW", o.key, { who, name: o.name, before: null, after: seen(o) }));
      continue;
    }
    const facts: ChangeFacts = { who, name: o.name, before: seen(old), after: seen(o) };
    if (old.price.currency !== o.price.currency) {
      out.push(change("CHANGED", o.key, facts));
      continue;
    }
    if (old.price.amount_minor === o.price.amount_minor) continue;
    const cheaper = o.price.amount_minor < old.price.amount_minor;
    out.push(change(cheaper ? "CHEAPER" : "DEARER", o.key, facts));
  }

  for (const old of args.before) {
    if (now.has(old.key) || !args.freshUrls.has(old.url)) continue;
    out.push(change("GONE", old.key, { who, name: old.name, before: seen(old), after: null }));
  }

  const a = args.ratingBefore;
  const b = args.ratingAfter;
  if (
    a &&
    b &&
    a.best === b.best &&
    Math.abs(Math.round(a.rating * 100) - Math.round(b.rating * 100)) >= 10
  ) {
    const facts: ChangeFacts = {
      who,
      name: null,
      before: null,
      after: null,
      rating_before: { rating: a.rating, best: a.best },
      rating_after: { rating: b.rating, best: b.best, count: b.count },
    };
    out.push({
      flag: "RATING",
      key: null,
      sentence: changeSentence("RATING", facts),
      before: a.rating,
      after: b.rating,
      facts,
    });
  }
  return out;
}
