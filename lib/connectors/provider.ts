// The provider contract — Phase 2 Session A. Every connector (fixture,
// Stripe, Shopify, WooCommerce, Google Analytics, Meta Ads) implements
// this and nothing else: it can prove a credential works, hand back daily
// observations from a cursor, and, where it has them, list the items an
// owner matches to their profile. It cannot write anywhere. The interface
// has no method for it, and the scope registry (scopes.ts) makes sure the
// credentials it holds could not either.

import type { BookingInput } from "../bookings/types";
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
  /**
   * P3-22a: Meta spend and the purchase value Meta attributes, per day, per
   * campaign (dimension campaign_ref). What "pause campaign X — return on
   * ad spend below 1.0 for 14 days" is computed from. Business-wide totals
   * stay in ad_spend.daily; these never enter them.
   */
  "ad_spend.campaign.daily",
  "ad_purchase_value.campaign.daily",
  /**
   * P2-20: Google Ads clicks and conversions, business-wide per day and per
   * campaign (campaign_ref). Google's conversions are the actions it counts
   * in "Conversions" — not necessarily purchases — so they are their own
   * series and never ad_purchases.daily. A count each (conversions keep
   * Google's fractions, to four decimals).
   */
  "ad_clicks.daily",
  "ad_conversions.daily",
  "ad_clicks.campaign.daily",
  "ad_conversions.campaign.daily",
  /**
   * P3-23a: one published post's own figures, dimensions {platform,
   * platform_post_id}, read through the EXECUTE connection's read-only
   * readback scopes (lib/content/insights.ts). Meta reports post insights
   * as LIFETIME totals only (Instagram: "period is lifetime and can't be
   * changed"; Facebook post_media_view: lifetime — docs read 2026-10-19), so
   * each row is the post's lifetime total as read on period_date, one
   * snapshot a day. Views-based only: no *_unique metric, no Instagram
   * impressions. Never business-wide: the dimension filter keeps them out
   * of every sum, the anomaly check and the watch.
   */
  "content.views.daily",
  "content.reach.daily",
  "content.interactions.daily",
  /**
   * Bookings (specs/bookings.md): appointments per day by what happened to
   * them, from Square's Bookings read or an owner's bookings export. Counted
   * on the day the appointment was for. cancelled_late is emitted only by a
   * source that separates late cancellations (Square does not).
   */
  "appointments_completed.daily",
  "appointments_no_show.daily",
  "appointments_cancelled_late.daily",
  "appointments_cancelled.daily",
  /** The price of completed appointments, per currency — list price, not takings. */
  "booking_revenue.daily",
  /**
   * Feature 34, slow stock: one stock SNAPSHOT per item, read on
   * period_date (the day it was read or, for an imported file, the day the
   * owner says it was counted). Dimensions {product_ref, item_name}. Never
   * a daily flow: nothing sums these across days.
   *
   *   stock.on_hand          units on hand that day (count)
   *   stock.value_at_cost    on hand × unit cost (money) — absent when any
   *                          stocked unit's cost is unknown, never partial
   *   stock.value_at_price   on hand × selling price (money)
   *
   * Two more come only from an imported stock file, which carries what a
   * till knows instead of order lines (lib/stock/import.ts):
   *
   *   stock.units_sold_window  units sold in the file's stated window,
   *                            dimension window_days ("90")
   *   stock.days_since_sale    days from the last sale to period_date
   */
  "stock.on_hand",
  "stock.value_at_cost",
  "stock.value_at_price",
  "stock.units_sold_window",
  "stock.days_since_sale",
  /**
   * I-54a: the account's closing balance that day (money), only from an
   * imported bank statement (lib/balance/import.ts). A snapshot, never
   * summed across days. No connector reads a balance.
   */
  "cash.balance",
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
  "ad_spend.campaign.daily",
  "ad_purchase_value.campaign.daily",
  "booking_revenue.daily",
  "stock.value_at_cost",
  "stock.value_at_price",
  "cash.balance",
]);

/** Feature 34: the snapshot metrics — read as of one day, never summed across days. */
export const STOCK_METRICS: ReadonlySet<MetricKey> = new Set([
  "stock.on_hand",
  "stock.value_at_cost",
  "stock.value_at_price",
  "stock.units_sold_window",
  "stock.days_since_sale",
]);

/**
 * Dimensions that LABEL a series without identifying it: stored on every
 * row (the latest re-read wins) but left out of the natural key, so a
 * renamed campaign keeps one history instead of splitting into two.
 */
export const LABEL_DIMENSIONS: ReadonlySet<string> = new Set(["campaign_name", "item_name"]);

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
  /** The ad platform's own campaign id — the series key of ad_*.campaign.daily (P3-22a). */
  campaign_ref?: string;
  /** The campaign's current name: a label, not part of the key (LABEL_DIMENSIONS). */
  campaign_name?: string;
  /** "facebook" | "instagram" — the platform a content.* figure was read from (P3-23a). */
  platform?: string;
  /** The platform's own id for the post (content_items.platform_post_id) — the series key of content.* (P3-23a). */
  platform_post_id?: string;
  /** Feature 34: the item's current name on a stock.* snapshot — a label, not part of the key. */
  item_name?: string;
  /** Feature 34: the window an imported units-sold figure covers, in days ("90"). */
  window_days?: string;
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
  /**
   * Bookings sources only (specs/bookings.md): the appointments read for
   * this page. The sync stores them with the page, hashing each client
   * identity on the way in; the daily counts are already in observations.
   */
  appointments?: BookingInput[];
  /**
   * Stores only (idea 48, bundles): which products went out together, per
   * order, for every counted order created in [from, to]. The window is
   * authoritative — the sync replaces the stored baskets of those days
   * with these, in the page's transaction — so a re-read drops an order
   * since cancelled. Read from the order lines the page already read.
   */
  baskets?: BasketWindow;
}

/** One order's distinct store product ids — no customer, no amounts. */
export interface BasketInput {
  /** The platform's own order id. */
  order_ref: string;
  /** "YYYY-MM-DD" — the same UTC day the order's revenue.daily row uses. */
  day: string;
  /** Distinct, sorted, never empty. */
  product_refs: string[];
}

export interface BasketWindow {
  from: string;
  to: string;
  orders: BasketInput[];
}

/** What the sync knows about the connection that a provider may need. */
export interface PullContext {
  /** Verbatim from the connection row, as verified at connect time. */
  granted_scopes: readonly string[];
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
  pull(secret: string, cursor: string | null, now: Date, context?: PullContext): Promise<PullPage>;
  /** Stores only (P2-15): every product, for mapping to the owner's offers. */
  listProducts?(secret: string): Promise<ExternalItem[]>;
  /** Analytics only (P2-18): the traffic channels seen, for mapping to the owner's channels. */
  listChannels?(secret: string): Promise<ExternalItem[]>;
  /**
   * Stores only (feature 34): today's stock snapshot, per product — on
   * hand, and its value at cost and at price where the store says them.
   * Read with the same read-only credential as everything else; the sync
   * runner calls it once per run, after the pages, and a failure here never
   * fails the sync. `hint.currency` is the store's currency as its own
   * orders report it, for a platform whose product list doesn't say.
   */
  readStock?(secret: string, now: Date, hint: { currency: string | null }): Promise<StockRead>;
  /**
   * Stores only (idea 47): the checkouts started in the last `days` days,
   * finished or not (a later finish is completed_at). Read-only, once per
   * run after the stock snapshot; a failure never fails the sync.
   */
  readAbandonedCheckouts?(secret: string, now: Date, days: number): Promise<CartRead>;
  /**
   * Review 2026-11-01: the email marketing setting of these addresses' customers,
   * so a contact made from a checkout keeps following the platform after its
   * cart ages out of the read. An address with no customer is left out.
   */
  readMarketingStates?(secret: string, emails: readonly string[]): Promise<MarketingStatesRead>;
}

/** One abandoned checkout as the platform reports it. Amounts already in minor units. */
export interface ExternalCart {
  /** The platform's own id. */
  ref: string;
  started_at: string;
  updated_at: string;
  completed_at: string | null;
  total_minor: number;
  currency: string;
  lines: {
    product_ref: string | null;
    title: string | null;
    quantity: number;
    unit_price_minor: number;
  }[];
  lines_truncated: boolean;
  /**
   * The shopper's email: hashed by the store on the way in, never kept.
   * Null when there is none, or the platform doesn't share it with this
   * credential (Shopify: only with the optional read_customers, I-47b).
   */
  email: string | null;
  /**
   * The platform's own "email me" tick; null when not read. A yes becomes a
   * contact's recorded consent only through lib/carts/consent.ts (I-47a).
   */
  accepts_marketing: boolean | null;
  /** The platform's own word for the tick (Shopify: SUBSCRIBED, UNSUBSCRIBED, …); null when not read. */
  marketing_state?: string | null;
  /** When the shopper last set it, as the platform says; null when it doesn't. */
  marketing_updated_at?: string | null;
  /** How they opted in, in the platform's words (Shopify: SINGLE_OPT_IN, CONFIRMED_OPT_IN, UNKNOWN). */
  marketing_opt_in_level?: string | null;
}

/** Review 2026-11-01: one customer's email marketing setting, re-checked by address. */
export interface MarketingState {
  email: string;
  /** The platform's word (Shopify: SUBSCRIBED, UNSUBSCRIBED, …); null when unknown. */
  state: string | null;
  updated_at: string | null;
  opt_in_level: string | null;
}

/** Review 2026-11-01: a re-check's answer, or why there is none. */
export type MarketingStatesRead =
  { kind: "read"; states: MarketingState[] } | { kind: "not_granted" } | { kind: "refused" };

export interface CartRead {
  carts: ExternalCart[];
  /**
   * Whether the shopper was read (I-47b): "read", "not_granted" when the
   * credential lacks the platform's customer permission, or "refused" when
   * it holds it but the platform still withheld customer data. Absent for a
   * platform that has no such permission.
   */
  shopper?: CartShopperRead;
}

export type CartShopperRead = "read" | "not_granted" | "refused";

/** One stock snapshot: the observations, and what couldn't be read (counted, never guessed). */
export interface StockRead {
  observations: Observation[];
  /** Products whose stock level could not be read (not tracked, or a shape we can't read). */
  untracked: number;
  /** Stocked products with no unit cost on the platform: their cash tied up is unknown. */
  cost_unknown: number;
}

export class ProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderError";
  }
}

/**
 * Review 2026-10-30: a store holding more abandoned checkouts than one read
 * takes. Never read short (a short read would understate what was left);
 * recorded on the connection so the carts screen can say why.
 */
export class TooManyCartsError extends ProviderError {
  constructor(message: string) {
    super(message);
    this.name = "TooManyCartsError";
  }
}
