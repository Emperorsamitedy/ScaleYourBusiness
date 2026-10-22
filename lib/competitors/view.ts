// What the Competitors screen shows — feature 35. Read-only assembly of
// the stored facts: the list with when each was last read (or honestly
// not), their prices beside the owner's, and the recent changes.

import type { Money } from "../core/money";
import type { ChangeFlag, ObservedRating } from "./changes";
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

/** Pure: how the last read went. */
export function readStateOf(c: CompetitorRecord): CompetitorCard["read"] {
  if (!c.status) return { state: "unread", at: null, problems: [] };
  const problems = c.status.pages
    .filter((p) => p.outcome !== "read")
    .map((p) => ({ url: p.url, reason: p.reason ?? "it couldn't be read" }));
  const read = c.status.pages.length - problems.length;
  const state: ReadState = read === 0 ? "failed" : problems.length > 0 ? "partial" : "read";
  return { state, at: c.status.read_at, problems };
}

/** Pure: every observed offer beside the owner's matching one. */
export function priceRows(list: readonly CompetitorRecord[], own: readonly OwnOffer[]): PriceRow[] {
  const rows: PriceRow[] = [];
  for (const c of list) {
    for (const o of c.offers?.offers ?? []) {
      const match = matchOffer(o, own, c.matches[o.key]);
      const yours = match?.offer ?? null;
      const gap = yours?.price ? priceGap(o.price, yours.price) : null;
      rows.push({
        competitor_id: c.id,
        competitor: c.name ?? "Unnamed competitor",
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
              ? "you haven't told me your price"
              : gap === null
                ? `priced in ${o.price.currency}, yours in ${yours.price.currency}; not converted`
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

export async function buildCompetitorsView(profileId: string): Promise<CompetitorsView> {
  const [all, own, changes] = await Promise.all([
    loadCompetitors(profileId),
    loadOwnOffers(profileId),
    recentChanges(profileId),
  ]);
  const list = all.filter((c) => c.tracked);
  const rows = priceRows(list, own);
  const gaps = rows.filter((r) => r.gap !== null);
  return {
    competitors: list.map((c) => ({
      id: c.id,
      name: c.name ?? "Unnamed competitor",
      url: c.url,
      listing_url: c.listing_url,
      price_pages: c.price_pages,
      pages: pagesOf(c).length,
      read: readStateOf(c),
      offers_seen: c.offers?.offers.length ?? 0,
      rating: c.rating
        ? { rating: c.rating.rating, best: c.rating.best, count: c.rating.count, url: c.rating.url }
        : null,
    })),
    rows,
    own_offers: own,
    changes: changes.map((ch) => {
      const meta = (ch.meta ?? {}) as { flag?: ChangeFlag; competitor_id?: string };
      return {
        at: ch.at,
        flag: meta.flag ?? "CHANGED",
        sentence: ch.detail,
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
