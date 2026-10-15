// The provider contract — Phase 2 Session A. Every connector (fixture,
// Stripe, Shopify, WooCommerce, Google Analytics, Meta Ads) implements
// this and nothing else: it can prove a credential works, hand back daily
// observations from a cursor, and, where it has them, list the items an
// owner matches to their profile. It cannot write anywhere. The interface
// has no method for it, and the scope registry (scopes.ts) makes sure the
// credentials it holds could not either.

import type { ProviderId } from "./scopes";

export const METRIC_KEYS = [
  "revenue.daily",
  "orders.daily",
  "ad_spend.daily",
  /** Purchases the ad platform attributes to its ads, per day (Session D). */
  "ad_purchases.daily",
  "sessions.daily",
  /** Units sold per day, per store product (Session C). */
  "units.daily",
  /**
   * P2-27: revenue and orders per UTC hour, dimension hour_utc. Stored in
   * UTC on purpose: an exact instant, so the business's local clock (and
   * its daylight saving) is applied when the series is read, and a
   * timezone learned later re-reads correctly without a re-sync. Only
   * hours with sales are emitted; the daily row of the same day says the
   * day was covered, so a missing hour is a zero, not a gap.
   */
  "revenue.hourly",
  "orders.hourly",
  /** P2-29: website sessions per UTC hour (GA4 dateHour, converted from the property's zone). */
  "sessions.hourly",
  /** P2-34: sessions that began on a page, and how many of them bounced — per day, per page_ref. */
  "landing_sessions.daily",
  "landing_bounces.daily",
  /** P2-34: searches made in the site's own search box, per day, per term_ref. */
  "site_search.daily",
  /**
   * P2-33: Google searches the site appeared for, per day, per query_ref.
   * Position is stored × impressions so averages are sums ÷ sums.
   */
  "search_impressions.daily",
  "search_clicks.daily",
  "search_position_weighted.daily",
] as const;

export type MetricKey = (typeof METRIC_KEYS)[number];

export function isMetricKey(value: string): value is MetricKey {
  return (METRIC_KEYS as readonly string[]).includes(value);
}

/** Metrics whose value is Money (rule 1): integer minor units + currency. */
export const MONEY_METRICS: ReadonlySet<MetricKey> = new Set([
  "revenue.daily",
  "ad_spend.daily",
  "revenue.hourly",
]);

/** Which slice of the business a daily figure belongs to. All optional. */
export interface ObservationDimensions {
  /** offers.<id> — reserved for figures already attributed to an offer. */
  offer_id?: string;
  /** channels.<id> — reserved for figures already attributed to a channel. */
  channel_id?: string;
  /** ISO 4217. Required for money metrics; part of the natural key. */
  currency?: string;
  /**
   * The store's own product id ("gid://shopify/Product/123", "812"). Raw
   * observations keep the platform's id; P2-15's confirmed mapping turns it
   * into an offer at derivation time, so a mapping can change without a
   * re-sync.
   */
  product_ref?: string;
  /** The analytics platform's channel name ("Paid Social"); mapped like product_ref (P2-18). */
  channel_ref?: string;
  /** "00".."23" — the UTC hour of an *.hourly figure; period_date is then the UTC date (P2-27). */
  hour_utc?: string;
  /** A site path ("/menu") — the landing page of landing_* figures (P2-34). */
  page_ref?: string;
  /** A visitor's site-search term, lower-cased and trimmed (P2-34). Content, never instructions. */
  term_ref?: string;
  /** A Google search query the site appeared for, lower-cased and trimmed (P2-33). */
  query_ref?: string;
}

/** One provider figure for one day. Exactly one of value_minor / value_num is set. */
export interface Observation {
  metric_key: MetricKey;
  /** "YYYY-MM-DD" — the day the figure is about, in the provider's accounting zone. */
  period_date: string;
  dimensions: ObservationDimensions;
  /** Money metrics: integer minor units (refunds already netted by the provider module). */
  value_minor?: number;
  /** Count and ratio metrics. */
  value_num?: number;
  /** When the provider reported it — observed_at on the resulting facts. */
  observed_at: string;
}

export interface PullPage {
  observations: Observation[];
  /** Where the NEXT pull resumes. Persisted after every page, so a killed run continues. */
  cursor: string | null;
  /** True when the provider has nothing further up to `now`. */
  done: boolean;
}

/** Something on the provider's side an owner can match to their profile: a product, a channel. */
export interface ExternalItem {
  /** The platform's id — what observations carry as product_ref or channel_ref. */
  ref: string;
  title: string;
  /** The platform's status word ("ACTIVE", "publish"), when it has one. */
  status: string | null;
}

/** A store's product, as the platform names it. */
export type ExternalProduct = ExternalItem;

/**
 * How far a provider's granted scopes can be trusted.
 *
 *   reported  The provider says exactly what the credential can do, and the
 *             registry check is a real proof (the fixture, Shopify, Google
 *             Analytics, Meta Ads).
 *   probed    The provider offers no way to list a credential's
 *             permissions. We prove every read we need works and that our
 *             own code can only read, but not that the credential lacks
 *             other permissions. Stripe restricted keys and WooCommerce
 *             keys are this (owner decision, 2026-09-14), and the
 *             connections screen says so.
 */
export type ScopeVerification = "reported" | "probed";

export interface Provider {
  id: ProviderId;
  /** Owner-facing name, e.g. "Stripe". */
  label: string;
  scopeVerification: ScopeVerification;
  /**
   * Prove the secret works and report which scopes it carries. The caller
   * verifies those against the registry before storing anything. For a
   * "probed" provider, these are the reads that were proven to work.
   */
  connect(secret: string): Promise<{ granted_scopes: string[] }>;
  /**
   * Pull one page of observations after `cursor` (null = start of a
   * backfill), never beyond `now`. Must be safe to call again with the
   * returned cursor — idempotent ingestion is the upsert's job, but a
   * provider must not skip or duplicate days between pages.
   */
  pull(secret: string, cursor: string | null, now: Date): Promise<PullPage>;
  /** Stores only (P2-15): every product, for mapping to the owner's offers. */
  listProducts?(secret: string): Promise<ExternalItem[]>;
  /** Analytics only (P2-18): the traffic channels seen, for mapping to the owner's channels. */
  listChannels?(secret: string): Promise<ExternalItem[]>;
}

export class ProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderError";
  }
}
