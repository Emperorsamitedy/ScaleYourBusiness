// What the Competitors screen shows — feature 35. Read-only assembly of
// the stored facts: the list with when each was last read (or honestly
// not), their prices beside the owner's, and the recent changes.
//
// L-4b: what SYB words here (a read's problem, a change's sentence, a
// price gap, a row's note) is in the reader's language through `w`
// ("competitorsWords", English by default). Competitor and offer names
// are content, as given (rules 4 and 24); what is stored stays English.

import type { Money } from "../core/money";
import type { ChangeFacts, ChangeFlag, CompetitorWords, ObservedRating } from "./changes";
import { changeSentence, englishCompetitorWords } from "./changes";
import type { MatchBasis, OwnOffer, PriceGap } from "./compare";
import { matchOffer, priceGap } from "./compare";
import type { ExtractMethod } from "./extract";
import type { CompetitorRecord } from "./service";
import { loadCompetitors, loadOwnOffers, pagesOf, recentChanges } from "./service";

export type ReadState = "unread" | "read" | "partial" | "failed";

export interface CompetitorCard {
  id: string;
  name: string;
  url: string | null;
  listing_url: string | null;
  price_pages: string[];
  pages: number;
  read: { state: ReadState; at: string | null; problems: { url: string; reason: string }[] };
  offers_seen: number;
  rating: Pick<ObservedRating, "rating" | "best" | "count" | "url"> | null;
}

export interface PriceRow {
  competitor_id: string;
  competitor: string;
  key: string;
  their_name: string;
  their_price: Money;
  from: boolean;
  method: ExtractMethod;
  url: string;
  yours: OwnOffer | null;
  basis: MatchBasis | null;
  gap: PriceGap | null;
  /** Why there is no gap, when there is a match. */
  note: string | null;
}

export interface ChangeRow {
  at: string;
  flag: ChangeFlag;
  sentence: string;
  competitor_id: string | null;
}

export interface CompetitorsView {
  competitors: CompetitorCard[];
  rows: PriceRow[];
  own_offers: OwnOffer[];
  changes: ChangeRow[];
  summary: { matched: number; below: number; above: number };
}

/** The reasons lib/competitors/read and lib/site/fetch store word for word: catalogue keys. */
const FIXED_REASONS = [
  "notAddress",
  "login",
  "deadline",
  "robotsUnread",
  "robotsNo",
  "redirectRobots",
  "redirectSite",
  "notPage",
  "unreachable",
  "couldntRead",
  "onlyHttp",
  "credentials",
  "private",
  "notWebAddress",
  "redirects",
] as const;

/** …and the ones that carry a figure or a host, with how to read it back out. */
const PATTERN_REASONS: readonly [
  string,
  RegExp,
  (m: RegExpMatchArray) => Record<string, string | number>,
][] = [
  ["cap", /^past the (\d+)-page limit per competitor$/, (m) => ({ pages: Number(m[1]) })],
  ["answered", /^the page answered (\d+)$/, (m) => ({ status: m[1]! })],
  ["timeout", /^no answer within (\d+) seconds$/, (m) => ({ seconds: Number(m[1]) })],
  ["resolve", /^"(.+)" doesn't resolve — is the address right\?$/, (m) => ({ host: m[1]! })],
  [
    "ports",
    /^only http\(s\) on the standard ports (\d+) and (\d+) can be read$/,
    (m) => ({ http: m[1]!, https: m[2]! }),
  ],
];

let fixedByText: Map<string, string> | null = null;

/**
 * A stored read problem in the reader's words (L-4b). A page's reason is
 * stored as the reader wrote it, in English (rule 4); one SYB knows is
 * said again from the catalogue — matched only when the catalogue's own
 * English gives back exactly the stored text — and anything else is shown
 * as stored.
 */
export function reasonIn(reason: string, w: CompetitorWords = englishCompetitorWords()): string {
  const en = englishCompetitorWords().tr;
  fixedByText ??= new Map(FIXED_REASONS.map((k) => [en(`reason.${k}`), k]));
  const fixed = fixedByText.get(reason);
  if (fixed) return w.tr(`reason.${fixed}`);
  for (const [key, re, values] of PATTERN_REASONS) {
    const m = reason.match(re);
    if (m && en(`reason.${key}`, values(m)) === reason) return w.tr(`reason.${key}`, values(m));
  }
  return reason;
}

/** Pure: how the last read went. */
export function readStateOf(
  c: CompetitorRecord,
  w: CompetitorWords = englishCompetitorWords(),
): CompetitorCard["read"] {
  if (!c.status) return { state: "unread", at: null, problems: [] };
  const problems = c.status.pages
    .filter((p) => p.outcome !== "read")
    .map((p) => ({
      url: p.url,
      reason: p.reason === null ? w.tr("reason.couldntRead") : reasonIn(p.reason, w),
    }));
  const read = c.status.pages.length - problems.length;
  const state: ReadState = read === 0 ? "failed" : problems.length > 0 ? "partial" : "read";
  return { state, at: c.status.read_at, problems };
}

/** Pure: every observed offer beside the owner's matching one. */
export function priceRows(
  list: readonly CompetitorRecord[],
  own: readonly OwnOffer[],
  w: CompetitorWords = englishCompetitorWords(),
): PriceRow[] {
  const rows: PriceRow[] = [];
  for (const c of list) {
    for (const o of c.offers?.offers ?? []) {
      const match = matchOffer(o, own, c.matches[o.key]);
      const yours = match?.offer ?? null;
      const gap = yours?.price ? priceGap(o.price, yours.price, w) : null;
      rows.push({
        competitor_id: c.id,
        competitor: c.name ?? w.tr("unnamed"),
        key: o.key,
        their_name: o.name,
        their_price: o.price,
        from: o.from,
        method: o.method,
        url: o.url,
        yours,
        basis: match?.basis ?? null,
        gap,
        note:
          yours === null
            ? null
            : yours.price === null
              ? w.tr("note.noPrice")
              : gap === null
                ? w.tr("note.currencies", {
                    theirs: o.price.currency,
                    yours: yours.price.currency,
                  })
                : null,
      });
    }
  }
  // Matched rows first, then by competitor and offer.
  return rows.sort(
    (a, b) =>
      Number(b.yours !== null) - Number(a.yours !== null) ||
      a.competitor.localeCompare(b.competitor) ||
      a.their_name.localeCompare(b.their_name),
  );
}

/**
 * A stored change in the reader's words: said again from its stored parts
 * when it has them (changes recorded since L-4b), else its stored English.
 */
export function changeIn(
  detail: string,
  meta: { flag?: ChangeFlag; facts?: ChangeFacts },
  w: CompetitorWords = englishCompetitorWords(),
): string {
  if (!meta.flag || !meta.facts || typeof meta.facts.who !== "string") return detail;
  return changeSentence(meta.flag, meta.facts, w);
}

export async function buildCompetitorsView(
  profileId: string,
  w: CompetitorWords = englishCompetitorWords(),
): Promise<CompetitorsView> {
  const [all, own, changes] = await Promise.all([
    loadCompetitors(profileId),
    loadOwnOffers(profileId),
    recentChanges(profileId),
  ]);
  const list = all.filter((c) => c.tracked);
  const rows = priceRows(list, own, w);
  const gaps = rows.filter((r) => r.gap !== null);
  return {
    competitors: list.map((c) => ({
      id: c.id,
      name: c.name ?? w.tr("unnamed"),
      url: c.url,
      listing_url: c.listing_url,
      price_pages: c.price_pages,
      pages: pagesOf(c).length,
      read: readStateOf(c, w),
      offers_seen: c.offers?.offers.length ?? 0,
      rating: c.rating
        ? { rating: c.rating.rating, best: c.rating.best, count: c.rating.count, url: c.rating.url }
        : null,
    })),
    rows,
    own_offers: own,
    changes: changes.map((ch) => {
      const meta = (ch.meta ?? {}) as {
        flag?: ChangeFlag;
        competitor_id?: string;
        facts?: ChangeFacts;
      };
      return {
        at: ch.at,
        flag: meta.flag ?? "CHANGED",
        sentence: changeIn(ch.detail, meta, w),
        competitor_id: meta.competitor_id ?? null,
      };
    }),
    summary: {
      matched: gaps.length,
      below: gaps.filter((r) => r.gap!.diff_minor < 0).length,
      above: gaps.filter((r) => r.gap!.diff_minor > 0).length,
    },
  };
}
