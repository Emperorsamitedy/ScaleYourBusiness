// The Shopify connector — Phase 2 Session C (P2-14..16).
//
// HOW AN OWNER CONNECTS (2026). Shopify stopped allowing new admin-created
// custom apps on 2026-01-01, so the plan's "custom app token" no longer
// exists for a new store. The replacement is an app the owner creates in
// Shopify's Dev Dashboard and installs on their own store. We store its
// store address, client ID and client secret, encrypted (rule 10), and swap
// them for a 24-hour access token with the client credentials grant. That
// grant works only when the app and the store belong to the same Shopify
// organization, which is exactly the owner-created case.
//
// READ-ONLY, PROVEN. Unlike Stripe, Shopify reports the exact scopes a
// token carries, so rule 9 is a real check here (scopeVerification:
// "reported"). The installation's scopes are read back at connect time; a
// write scope, or anything outside the registry, refuses the connection;
// and the required reads must be present. Shopify's Admin API is GraphQL,
// which sends even reads as a request body, so the guard is not "GET
// only". It is this: the only documents this module can send are the fixed
// read queries in SHOPIFY_QUERIES, the only other request is the token
// exchange, and shopify.test.ts fails the build if either changes.
//
// Requests only ever go to a *.myshopify.com address: the owner types the
// store address, and it is validated before anything is sent, so this
// server cannot be pointed somewhere else.
//
// HISTORY. Orders older than 60 days need the read_all_orders scope, which
// Shopify grants only on approval. With it the backfill reads a year;
// without it, 60 days, and the connections screen says which.
//
// THE ARITHMETIC. Revenue for a day is the total of the orders created that
// day minus what has been refunded on them, including tax and shipping as
// Stripe's charges do, excluding cancelled and test orders. A refund
// changes an order after it was counted, so every sync re-reads the last
// 30 days; a refund issued more than 30 days after its order is not
// reflected. Units per product are line items' current quantity, keyed by
// Shopify's product id (product_ref), which P2-15 maps to the owner's offers.
//
// STOCK (feature 34). Once per sync, a snapshot of every product's stock:
// the sum of its tracked variants' sellable quantity, valued at each
// variant's price and at its inventory item's unit cost. Both live under
// read_products, which the connector already holds: Shopify's docs (read
// 2026-10-22) say ProductVariant "Requires read_products access scope" and
// InventoryItem "Requires read_inventory access scope or read_products
// access scope", so no scope was added. A product with no tracked variant
// is counted, not guessed; a stocked variant without a unit cost makes the
// product's cash tied up unknown, never a partial sum.
//
// BASKETS (idea 48). Each page also hands back, per counted order, the set
// of product ids its lines still hold, so bundles can be mined. They come
// from the product ids the Orders query already reads: no field, query or
// scope was added.
//
// ABANDONED CARTS (idea 47). Once per sync, the checkouts started in the
// last 60 days, finished or not, through abandonedCheckouts. Shopify's docs
// (read 2026-10-29, Admin GraphQL 2026-10): the query and AbandonedCheckout
// "Requires read_orders access scope", which the connector already holds,
// so no scope was added. Fields read: id, createdAt, updatedAt,
// completedAt, totalPriceSet, and per line title, quantity,
// originalUnitPriceSet and product { id } (Product sits under
// read_products, also held). NOT read, on purpose: the shopper. The
// checkout has no email field of its own; the address is on its customer
// (customer.email, deprecated for defaultEmailAddress.emailAddress), and
// the Customer type "Requires read_customers access scope". The marketing
// tick lives there too (defaultEmailAddress.marketingState). SYB doesn't
// hold read_customers and doesn't add it here, so every cart is read
// without its shopper: `email` and `accepts_marketing` are null. Asking for
// read_customers is an owner decision (TASKS-FEEDBACK.md I-47b), and so is
// the protected customer data access Shopify puts email under (level 2).

import { basketOf } from "../baskets";
import { addDays, advanceCursor, dayString, isoSeconds, oneNewDay, planWindow } from "../days";
import { DecimalError, decimalToMinor } from "../decimal";
import { HourlyBuckets } from "../hourly";
import type {
  BasketWindow,
  CartRead,
  ExternalCart,
  ExternalProduct,
  Observation,
  Provider,
  PullPage,
  StockRead,
} from "../provider";
import { ProviderError, TooManyCartsError } from "../provider";

/** Pinned to the latest stable version (supported for at least 12 months). */
export const SHOPIFY_API_VERSION = "2026-07";

export const SHOPIFY_REQUIRED_SCOPES = ["read_orders", "read_products"] as const;
export const SHOPIFY_ALL_ORDERS_SCOPE = "read_all_orders";
export const SHOPIFY_FULL_HISTORY_DAYS = 365;
/** What Shopify lets a token see without read_all_orders. */
export const SHOPIFY_DEFAULT_HISTORY_DAYS = 60;
export const SHOPIFY_WINDOW_DAYS = 30;
export const SHOPIFY_REREAD_DAYS = 30;
/** Orders per page × line items per order stays under the 1,000-point query cost cap. */
export const SHOPIFY_ORDERS_PAGE = 50;
export const SHOPIFY_LINE_ITEMS_PAGE = 15;
export const SHOPIFY_MAX_PAGES_PER_WINDOW = 100;
export const SHOPIFY_MAX_LINE_ITEM_PAGES = 20;
export const SHOPIFY_MAX_PRODUCT_PAGES = 40;
export const SHOPIFY_MAX_ATTEMPTS = 3;
/** Products per stock page × variants per product stays under the 1,000-point query cost cap. */
export const SHOPIFY_STOCK_PAGE = 10;
export const SHOPIFY_STOCK_VARIANTS = 50;
export const SHOPIFY_MAX_STOCK_PAGES = 200;
/** Carts per page × lines per cart stays under the 1,000-point query cost cap. */
export const SHOPIFY_CARTS_PAGE = 50;
export const SHOPIFY_CART_LINES = 15;
export const SHOPIFY_MAX_CART_PAGES = 40;

/**
 * Every document this module can send. All are read queries; the source
 * scan in shopify.test.ts holds that true.
 */
export const SHOPIFY_QUERIES = {
  access_scopes: `query AccessScopes {
  currentAppInstallation {
    accessScopes {
      handle
    }
  }
}`,
  orders: `query Orders($first: Int!, $lineItems: Int!, $after: String, $search: String!) {
  orders(first: $first, after: $after, sortKey: CREATED_AT, query: $search) {
    nodes {
      id
      createdAt
      cancelledAt
      test
      totalPriceSet {
        shopMoney {
          amount
          currencyCode
        }
      }
      totalRefundedSet {
        shopMoney {
          amount
          currencyCode
        }
      }
      lineItems(first: $lineItems) {
        nodes {
          currentQuantity
          product {
            id
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}`,
  order_line_items: `query OrderLineItems($id: ID!, $after: String) {
  order(id: $id) {
    lineItems(first: 250, after: $after) {
      nodes {
        currentQuantity
        product {
          id
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
}`,
  products: `query Products($after: String) {
  products(first: 250, after: $after) {
    nodes {
      id
      title
      status
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}`,
  stock: `query Stock($first: Int!, $variants: Int!, $after: String) {
  shop {
    currencyCode
  }
  products(first: $first, after: $after) {
    nodes {
      id
      title
      variants(first: $variants) {
        nodes {
          inventoryQuantity
          price
          inventoryItem {
            tracked
            unitCost {
              amount
              currencyCode
            }
          }
        }
        pageInfo {
          hasNextPage
        }
      }
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}`,
  abandoned_checkouts: `query AbandonedCheckouts($first: Int!, $lineItems: Int!, $after: String, $search: String!) {
  abandonedCheckouts(first: $first, after: $after, sortKey: CREATED_AT, query: $search) {
    nodes {
      id
      createdAt
      updatedAt
      completedAt
      totalPriceSet {
        shopMoney {
          amount
          currencyCode
        }
      }
      lineItems(first: $lineItems) {
        nodes {
          title
          quantity
          originalUnitPriceSet {
            shopMoney {
              amount
              currencyCode
            }
          }
          product {
            id
          }
        }
        pageInfo {
          hasNextPage
        }
      }
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}`,
} as const;

export type ShopifyQueryName = keyof typeof SHOPIFY_QUERIES;

export interface ShopifyRequestInit {
  method: "POST";
  headers: Record<string, string>;
  body: string;
}

export interface ShopifyResponse {
  status: number;
  json(): Promise<unknown>;
}

export type ShopifyFetch = (url: string, init: ShopifyRequestInit) => Promise<ShopifyResponse>;

export interface ShopifyProviderOptions {
  fetch?: ShopifyFetch;
  sleep?: (ms: number) => Promise<void>;
}

export interface ShopifyCredential {
  shop: string;
  client_id: string;
  client_secret: string;
}

const SHOP_RE = /^[a-z0-9][a-z0-9-]{0,60}\.myshopify\.com$/;

/**
 * Parse the stored credential. The store address is normalised and must be
 * a *.myshopify.com host: this is the guard that keeps every request on
 * Shopify.
 */
export function parseShopifyCredential(secret: string): ShopifyCredential {
  let raw: unknown;
  try {
    raw = JSON.parse(secret);
  } catch {
    throw new ProviderError(
      "shopify: the store address, client ID and client secret are all needed",
    );
  }
  const c = (raw ?? {}) as Partial<Record<keyof ShopifyCredential, unknown>>;
  const shop =
    typeof c.shop === "string"
      ? c.shop
          .trim()
          .toLowerCase()
          .replace(/^https?:\/\//, "")
          .replace(/\/.*$/, "")
      : "";
  if (!SHOP_RE.test(shop)) {
    throw new ProviderError(
      "shopify: the store address must be your store's myshopify.com address, like your-store.myshopify.com",
    );
  }
  const client_id = typeof c.client_id === "string" ? c.client_id.trim() : "";
  const client_secret = typeof c.client_secret === "string" ? c.client_secret.trim() : "";
  if (client_id === "" || client_secret === "") {
    throw new ProviderError("shopify: both the client ID and the client secret are needed");
  }
  return { shop, client_id, client_secret };
}

interface Token {
  value: string;
  scopes: string[];
  expiresAt: number;
}

interface Context {
  fetch: ShopifyFetch;
  sleep: (ms: number) => Promise<void>;
  tokens: Map<string, Token>;
}

function backoffMs(attempt: number): number {
  return 1000 * attempt + Math.floor(Math.random() * 250);
}

function splitScopes(scope: unknown): string[] {
  return typeof scope === "string"
    ? scope
        .split(/[\s,]+/)
        .map((s) => s.trim())
        .filter((s) => s !== "")
    : [];
}

/** A 24-hour token from the client credentials grant, cached until shortly before it expires. */
async function accessToken(ctx: Context, cred: ShopifyCredential, fresh = false): Promise<Token> {
  const cacheKey = `${cred.shop}|${cred.client_id}`;
  const cached = ctx.tokens.get(cacheKey);
  if (!fresh && cached && cached.expiresAt - 60_000 > Date.now()) return cached;

  const url = `https://${cred.shop}/admin/oauth/access_token`;
  for (let attempt = 1; ; attempt += 1) {
    let response: ShopifyResponse;
    try {
      response = await ctx.fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: cred.client_id,
          client_secret: cred.client_secret,
        }).toString(),
      });
    } catch {
      if (attempt >= SHOPIFY_MAX_ATTEMPTS) {
        throw new ProviderError(`shopify: network failure after ${attempt} attempts`);
      }
      await ctx.sleep(backoffMs(attempt));
      continue;
    }
    if ((response.status === 429 || response.status >= 500) && attempt < SHOPIFY_MAX_ATTEMPTS) {
      await ctx.sleep(backoffMs(attempt));
      continue;
    }
    if (response.status !== 200) {
      throw new ProviderError(
        "shopify: those credentials were not accepted. Check the client ID and secret, and that the app is installed on this store",
      );
    }
    const body = (await response.json().catch(() => null)) as {
      access_token?: unknown;
      scope?: unknown;
      expires_in?: unknown;
    } | null;
    if (typeof body?.access_token !== "string" || body.access_token === "") {
      throw new ProviderError("shopify: the token response had no access token");
    }
    const seconds = typeof body.expires_in === "number" ? body.expires_in : 3600;
    const token: Token = {
      value: body.access_token,
      scopes: splitScopes(body.scope),
      expiresAt: Date.now() + seconds * 1000,
    };
    ctx.tokens.set(cacheKey, token);
    return token;
  }
}

/** One read query. Throttling, expired tokens and server errors retry to the cap. */
async function graphql(
  ctx: Context,
  cred: ShopifyCredential,
  name: ShopifyQueryName,
  variables: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const url = `https://${cred.shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
  let fresh = false;

  for (let attempt = 1; ; attempt += 1) {
    const token = await accessToken(ctx, cred, fresh);
    fresh = false;
    let response: ShopifyResponse;
    try {
      response = await ctx.fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          "x-shopify-access-token": token.value,
        },
        body: JSON.stringify({ query: SHOPIFY_QUERIES[name], variables }),
      });
    } catch {
      if (attempt >= SHOPIFY_MAX_ATTEMPTS) {
        throw new ProviderError(`shopify: network failure after ${attempt} attempts`);
      }
      await ctx.sleep(backoffMs(attempt));
      continue;
    }

    if (response.status === 401 && attempt < SHOPIFY_MAX_ATTEMPTS) {
      fresh = true; // the token expired or was revoked: exchange again once
      continue;
    }
    if (response.status === 401) {
      throw new ProviderError("shopify: the store stopped accepting this app's token");
    }
    if (response.status === 403) {
      throw new ProviderError("shopify: the app is missing a read permission it needs");
    }
    if ((response.status === 429 || response.status >= 500) && attempt < SHOPIFY_MAX_ATTEMPTS) {
      await ctx.sleep(backoffMs(attempt));
      continue;
    }
    if (response.status !== 200) {
      throw new ProviderError(`shopify: request failed with status ${response.status}`);
    }

    const body = (await response.json().catch(() => null)) as {
      data?: unknown;
      errors?: { message?: unknown; extensions?: { code?: unknown } }[];
    } | null;
    const errors = Array.isArray(body?.errors) ? body.errors : [];
    if (errors.some((e) => e?.extensions?.code === "THROTTLED")) {
      if (attempt < SHOPIFY_MAX_ATTEMPTS) {
        await ctx.sleep(backoffMs(attempt));
        continue;
      }
      throw new ProviderError(`shopify: still throttled after ${attempt} attempts`);
    }
    if (errors.length > 0) {
      const message = errors
        .map((e) => (typeof e?.message === "string" ? e.message : "unknown error"))
        .join("; ");
      throw new ProviderError(`shopify: ${message}`);
    }
    if (body?.data === null || typeof body?.data !== "object") {
      throw new ProviderError("shopify: unexpected response shape");
    }
    return body.data as Record<string, unknown>;
  }
}

/* ── parsing ── */

interface Connection<T> {
  nodes: T[];
  hasNextPage: boolean;
  endCursor: string | null;
}

function parseConnection(value: unknown, what: string): Connection<unknown> {
  const c = value as { nodes?: unknown; pageInfo?: { hasNextPage?: unknown; endCursor?: unknown } };
  if (!c || !Array.isArray(c.nodes) || typeof c.pageInfo?.hasNextPage !== "boolean") {
    throw new ProviderError(`shopify: unexpected ${what} response shape`);
  }
  return {
    nodes: c.nodes,
    hasNextPage: c.pageInfo.hasNextPage,
    endCursor: typeof c.pageInfo.endCursor === "string" ? c.pageInfo.endCursor : null,
  };
}

export interface ShopifyLine {
  quantity: number;
  productRef: string | null;
}

export interface ShopifyOrder {
  id: string;
  createdAt: string;
  cancelledAt: string | null;
  test: boolean;
  total: string;
  refunded: string;
  currency: string;
  lines: ShopifyLine[];
}

function parseLine(value: unknown): ShopifyLine {
  const l = value as { currentQuantity?: unknown; product?: { id?: unknown } | null };
  if (!l || !Number.isSafeInteger(l.currentQuantity)) {
    throw new ProviderError("shopify: a line item is missing its quantity");
  }
  return {
    quantity: l.currentQuantity as number,
    // A custom line item has no product; it counts toward revenue, not units.
    productRef: typeof l.product?.id === "string" ? l.product.id : null,
  };
}

function money(value: unknown): { amount: string; currencyCode: string } | null {
  const m = (value as { shopMoney?: { amount?: unknown; currencyCode?: unknown } } | null)
    ?.shopMoney;
  return typeof m?.amount === "string" && typeof m.currencyCode === "string"
    ? { amount: m.amount, currencyCode: m.currencyCode }
    : null;
}

function parseOrder(value: unknown): { order: ShopifyOrder; moreLines: string | null } {
  const o = value as {
    id?: unknown;
    createdAt?: unknown;
    cancelledAt?: unknown;
    test?: unknown;
    totalPriceSet?: unknown;
    totalRefundedSet?: unknown;
    lineItems?: unknown;
  };
  const total = money(o?.totalPriceSet);
  const refunded = money(o?.totalRefundedSet);
  if (
    !o ||
    typeof o.id !== "string" ||
    typeof o.createdAt !== "string" ||
    (o.cancelledAt !== null && typeof o.cancelledAt !== "string") ||
    typeof o.test !== "boolean" ||
    total === null ||
    refunded === null
  ) {
    throw new ProviderError("shopify: an order is missing a field the connector relies on");
  }
  const lines = parseConnection(o.lineItems, "line items");
  return {
    order: {
      id: o.id,
      createdAt: o.createdAt,
      cancelledAt: o.cancelledAt as string | null,
      test: o.test,
      total: total.amount,
      refunded: refunded.amount,
      currency: total.currencyCode,
      lines: lines.nodes.map(parseLine),
    },
    moreLines: lines.hasNextPage ? lines.endCursor : null,
  };
}

async function remainingLines(
  ctx: Context,
  cred: ShopifyCredential,
  orderId: string,
  cursor: string,
): Promise<ShopifyLine[]> {
  const out: ShopifyLine[] = [];
  let after: string | null = cursor;
  for (let page = 0; page < SHOPIFY_MAX_LINE_ITEM_PAGES && after !== null; page += 1) {
    const data = await graphql(ctx, cred, "order_line_items", { id: orderId, after });
    const order = data["order"] as { lineItems?: unknown } | null;
    const lines = parseConnection(order?.lineItems, "line items");
    out.push(...lines.nodes.map(parseLine));
    after = lines.hasNextPage ? lines.endCursor : null;
  }
  if (after !== null) {
    throw new ProviderError(`shopify: order ${orderId} has more line items than one sync reads`);
  }
  return out;
}

async function fetchOrders(
  ctx: Context,
  cred: ShopifyCredential,
  start: Date,
  end: Date,
): Promise<ShopifyOrder[] | "too_many"> {
  const search = `created_at:>='${isoSeconds(start)}' created_at:<'${isoSeconds(addDays(end, 1))}'`;
  const out: ShopifyOrder[] = [];
  let after: string | null = null;
  for (let page = 0; page < SHOPIFY_MAX_PAGES_PER_WINDOW; page += 1) {
    const data = await graphql(ctx, cred, "orders", {
      first: SHOPIFY_ORDERS_PAGE,
      lineItems: SHOPIFY_LINE_ITEMS_PAGE,
      after,
      search,
    });
    const orders = parseConnection(data["orders"], "orders");
    for (const node of orders.nodes) {
      const { order, moreLines } = parseOrder(node);
      if (moreLines !== null)
        order.lines.push(...(await remainingLines(ctx, cred, order.id, moreLines)));
      out.push(order);
    }
    if (!orders.hasNextPage) return out;
    if (orders.endCursor === null) {
      throw new ProviderError("shopify: hasNextPage without a cursor to continue from");
    }
    after = orders.endCursor;
  }
  return "too_many";
}

/* ── arithmetic ── */

/**
 * Daily observations for every day in [start, end]: revenue per currency
 * (zero days included), order count (zero days included), and units per
 * product for products that sold.
 */
export function aggregateOrders(
  orders: readonly ShopifyOrder[],
  start: Date,
  end: Date,
  observedAt: string,
): Observation[] {
  const revenue = new Map<string, Map<string, number>>();
  const counts = new Map<string, number>();
  const units = new Map<string, Map<string, number>>();
  const currencies = new Set<string>();
  const hourly = new HourlyBuckets(); // P2-27
  const from = start.getTime();
  const until = addDays(end, 1).getTime();

  for (const o of orders) {
    if (o.test || o.cancelledAt !== null) continue;
    const at = Date.parse(o.createdAt);
    if (!Number.isFinite(at) || at < from || at >= until) continue;
    const day = dayString(new Date(at));
    const currency = o.currency.toUpperCase();
    let net: number;
    try {
      net = decimalToMinor(o.total, currency) - decimalToMinor(o.refunded, currency);
    } catch (error) {
      if (error instanceof DecimalError) {
        throw new ProviderError(`shopify: order ${o.id}: ${error.message}`);
      }
      throw error;
    }
    currencies.add(currency);
    const byCurrency = revenue.get(day) ?? new Map<string, number>();
    byCurrency.set(currency, (byCurrency.get(currency) ?? 0) + net);
    revenue.set(day, byCurrency);
    counts.set(day, (counts.get(day) ?? 0) + 1);
    hourly.addRevenue(at, currency, net);
    hourly.addOrder(at);

    for (const line of o.lines) {
      if (line.productRef === null || line.quantity <= 0) continue;
      const byProduct = units.get(day) ?? new Map<string, number>();
      byProduct.set(line.productRef, (byProduct.get(line.productRef) ?? 0) + line.quantity);
      units.set(day, byProduct);
    }
  }

  const sortedCurrencies = [...currencies].sort();
  const out: Observation[] = [];
  for (let d = start; d.getTime() <= end.getTime(); d = addDays(d, 1)) {
    const day = dayString(d);
    for (const currency of sortedCurrencies) {
      out.push({
        metric_key: "revenue.daily",
        period_date: day,
        dimensions: { currency },
        value_minor: revenue.get(day)?.get(currency) ?? 0,
        observed_at: observedAt,
      });
    }
    out.push({
      metric_key: "orders.daily",
      period_date: day,
      dimensions: {},
      value_num: counts.get(day) ?? 0,
      observed_at: observedAt,
    });
    const byProduct = units.get(day);
    if (byProduct) {
      for (const [productRef, quantity] of [...byProduct.entries()].sort(([a], [b]) =>
        a < b ? -1 : a > b ? 1 : 0,
      )) {
        out.push({
          metric_key: "units.daily",
          period_date: day,
          dimensions: { product_ref: productRef },
          value_num: quantity,
          observed_at: observedAt,
        });
      }
    }
  }
  out.push(...hourly.observations(observedAt));
  return out;
}

/**
 * Idea 48: one basket per counted order created in [start, end] — the
 * same orders aggregateOrders counts (no test or cancelled order), on the
 * same UTC day, with the products still in it.
 */
export function basketsOfOrders(
  orders: readonly ShopifyOrder[],
  start: Date,
  end: Date,
): BasketWindow {
  const from = start.getTime();
  const until = addDays(end, 1).getTime();
  const out: BasketWindow = { from: dayString(start), to: dayString(end), orders: [] };
  for (const o of orders) {
    if (o.test || o.cancelledAt !== null) continue;
    const at = Date.parse(o.createdAt);
    if (!Number.isFinite(at) || at < from || at >= until) continue;
    const basket = basketOf(o.id, dayString(new Date(at)), o.lines);
    if (basket) out.orders.push(basket);
  }
  return out;
}

/* ── stock (feature 34) ── */

export interface ShopifyStockVariant {
  quantity: number | null;
  price: string;
  tracked: boolean;
  unitCost: { amount: string; currencyCode: string } | null;
}

export interface ShopifyStockProduct {
  id: string;
  title: string;
  variants: ShopifyStockVariant[];
  /** More variants than one page reads: the product is counted, not summed short. */
  truncated: boolean;
}

export function parseStockProduct(value: unknown): ShopifyStockProduct {
  const p = value as { id?: unknown; title?: unknown; variants?: unknown } | null;
  if (!p || typeof p.id !== "string" || typeof p.title !== "string") {
    throw new ProviderError("shopify: a product is missing its id or title");
  }
  const v = p.variants as { nodes?: unknown; pageInfo?: { hasNextPage?: unknown } } | null;
  if (!v || !Array.isArray(v.nodes)) {
    throw new ProviderError("shopify: unexpected variants response shape");
  }
  const variants = v.nodes.map((node): ShopifyStockVariant => {
    const n = node as {
      inventoryQuantity?: unknown;
      price?: unknown;
      inventoryItem?: { tracked?: unknown; unitCost?: unknown } | null;
    } | null;
    if (!n || typeof n.price !== "string") {
      throw new ProviderError("shopify: a variant is missing its price");
    }
    const cost = n.inventoryItem?.unitCost as { amount?: unknown; currencyCode?: unknown } | null;
    return {
      quantity: Number.isSafeInteger(n.inventoryQuantity) ? (n.inventoryQuantity as number) : null,
      price: n.price,
      tracked: n.inventoryItem?.tracked === true,
      unitCost:
        cost && typeof cost.amount === "string" && typeof cost.currencyCode === "string"
          ? { amount: cost.amount, currencyCode: cost.currencyCode }
          : null,
    };
  });
  return { id: p.id, title: p.title, variants, truncated: v.pageInfo?.hasNextPage === true };
}

/**
 * Pure: one snapshot day's observations from the store's products. Per
 * product: units on hand (tracked variants, an oversold negative counting
 * as none), their value at price, and at cost when every stocked variant
 * has a cost in the shop's currency.
 */
export function aggregateStock(
  products: readonly ShopifyStockProduct[],
  currency: string,
  day: string,
  observedAt: string,
): StockRead {
  const out: Observation[] = [];
  let untracked = 0;
  let costUnknown = 0;
  const code = currency.toUpperCase();
  for (const p of products) {
    const tracked = p.variants.filter((v) => v.tracked && v.quantity !== null);
    if (p.truncated || tracked.length === 0) {
      untracked += 1;
      continue;
    }
    let onHand = 0;
    let atPrice = 0;
    let atCost: number | null = 0;
    try {
      for (const v of tracked) {
        const q = Math.max(0, v.quantity ?? 0);
        onHand += q;
        atPrice += q * decimalToMinor(v.price, code);
        if (q === 0 || atCost === null) continue;
        atCost =
          v.unitCost && v.unitCost.currencyCode.toUpperCase() === code
            ? atCost + q * decimalToMinor(v.unitCost.amount, code)
            : null;
      }
    } catch (error) {
      if (error instanceof DecimalError) {
        throw new ProviderError(`shopify: product ${p.id}: ${error.message}`);
      }
      throw error;
    }
    const dims = { product_ref: p.id, item_name: p.title };
    out.push({
      metric_key: "stock.on_hand",
      period_date: day,
      dimensions: dims,
      value_num: onHand,
      observed_at: observedAt,
    });
    out.push({
      metric_key: "stock.value_at_price",
      period_date: day,
      dimensions: { ...dims, currency: code },
      value_minor: atPrice,
      observed_at: observedAt,
    });
    if (atCost === null) {
      costUnknown += 1;
    } else {
      out.push({
        metric_key: "stock.value_at_cost",
        period_date: day,
        dimensions: { ...dims, currency: code },
        value_minor: atCost,
        observed_at: observedAt,
      });
    }
  }
  return { observations: out, untracked, cost_unknown: costUnknown };
}

/* ── abandoned carts (idea 47) ── */

/**
 * Pure: one cart from the AbandonedCheckouts response, amounts in minor
 * units of the shop's currency. The shopper is never part of it: the
 * document doesn't ask (see the header).
 */
export function parseCart(value: unknown): ExternalCart {
  const c = value as {
    id?: unknown;
    createdAt?: unknown;
    updatedAt?: unknown;
    completedAt?: unknown;
    totalPriceSet?: unknown;
    lineItems?: { nodes?: unknown; pageInfo?: { hasNextPage?: unknown } } | null;
  } | null;
  const total = money(c?.totalPriceSet);
  if (
    !c ||
    typeof c.id !== "string" ||
    typeof c.createdAt !== "string" ||
    typeof c.updatedAt !== "string" ||
    (c.completedAt !== null && typeof c.completedAt !== "string") ||
    total === null ||
    !Array.isArray(c.lineItems?.nodes)
  ) {
    throw new ProviderError("shopify: a checkout is missing a field the connector relies on");
  }
  const id = c.id;
  const currency = total.currencyCode.toUpperCase();
  try {
    const lines = (c.lineItems.nodes as unknown[]).map((node) => {
      const l = node as {
        title?: unknown;
        quantity?: unknown;
        originalUnitPriceSet?: unknown;
        product?: { id?: unknown } | null;
      } | null;
      const price = money(l?.originalUnitPriceSet);
      if (!l || !Number.isSafeInteger(l.quantity) || price === null) {
        throw new ProviderError(`shopify: checkout ${id} has a line without its quantity or price`);
      }
      if (price.currencyCode.toUpperCase() !== currency) {
        throw new ProviderError(`shopify: checkout ${id} mixes currencies`);
      }
      return {
        product_ref: typeof l.product?.id === "string" ? l.product.id : null,
        title: typeof l.title === "string" ? l.title : null,
        quantity: l.quantity as number,
        unit_price_minor: decimalToMinor(price.amount, currency),
      };
    });
    return {
      ref: id,
      started_at: c.createdAt,
      updated_at: c.updatedAt,
      completed_at: c.completedAt as string | null,
      total_minor: decimalToMinor(total.amount, currency),
      currency,
      lines,
      lines_truncated: c.lineItems.pageInfo?.hasNextPage === true,
      email: null,
      accepts_marketing: null,
    };
  } catch (error) {
    if (error instanceof DecimalError) {
      throw new ProviderError(`shopify: checkout ${id}: ${error.message}`);
    }
    throw error;
  }
}

/* ── the provider ── */

export function historyDaysFor(scopes: readonly string[]): number {
  return scopes.includes(SHOPIFY_ALL_ORDERS_SCOPE)
    ? SHOPIFY_FULL_HISTORY_DAYS
    : SHOPIFY_DEFAULT_HISTORY_DAYS;
}

/** A Shopify call that stalls must not hang the sync cron (review 2026-10-23, #24). */
export const SHOPIFY_FETCH_TIMEOUT_MS = 20_000;

/** The live fetch, with its timeout. Exported for its test. */
export const shopifyLiveFetch: ShopifyFetch = async (url, init) => {
  const response = await fetch(url, {
    method: init.method,
    headers: init.headers,
    body: init.body,
    cache: "no-store",
    signal: AbortSignal.timeout(SHOPIFY_FETCH_TIMEOUT_MS),
  });
  return { status: response.status, json: () => response.json() as Promise<unknown> };
};

const defaultFetch: ShopifyFetch = shopifyLiveFetch;

export function createShopifyProvider(options: ShopifyProviderOptions = {}): Provider {
  const ctx: Context = {
    fetch: options.fetch ?? defaultFetch,
    sleep: options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    tokens: new Map(),
  };

  return {
    id: "shopify",
    label: "Shopify",
    scopeVerification: "reported",

    async connect(secret) {
      const cred = parseShopifyCredential(secret);
      const token = await accessToken(ctx, cred, true);
      const data = await graphql(ctx, cred, "access_scopes", {});
      const installation = data["currentAppInstallation"] as {
        accessScopes?: { handle?: unknown }[];
      } | null;
      if (!Array.isArray(installation?.accessScopes)) {
        throw new ProviderError("shopify: could not read the app's granted scopes");
      }
      const installed = installation.accessScopes
        .map((s) => (typeof s?.handle === "string" ? s.handle : ""))
        .filter((s) => s !== "");
      // The token's own readback and the installation both count: a scope
      // either one reports is a scope the credential has.
      const granted = [...new Set([...installed, ...token.scopes])].sort();

      const missing = SHOPIFY_REQUIRED_SCOPES.filter((s) => !granted.includes(s));
      if (missing.length > 0) {
        throw new ProviderError(
          `shopify: the app needs ${missing.join(" and ")}. Add it in the app's Dev Dashboard version, release, and connect again`,
        );
      }
      return { granted_scopes: granted };
    },

    async pull(secret, cursor, now): Promise<PullPage> {
      const cred = parseShopifyCredential(secret);
      const token = await accessToken(ctx, cred);
      const plan = planWindow({
        cursor,
        now,
        historyDays: historyDaysFor(token.scopes),
        rereadDays: SHOPIFY_REREAD_DAYS,
        windowDays: SHOPIFY_WINDOW_DAYS,
        provider: "shopify",
      });
      if (plan === null) return { observations: [], cursor, done: true };

      let { start, end } = plan;
      let orders = await fetchOrders(ctx, cred, start, end);
      if (orders === "too_many") {
        const day = oneNewDay(plan);
        if (day === null) return { observations: [], cursor, done: true };
        start = day;
        end = day;
        orders = await fetchOrders(ctx, cred, start, end);
        if (orders === "too_many") {
          throw new ProviderError(
            `shopify: more than ${SHOPIFY_ORDERS_PAGE * SHOPIFY_MAX_PAGES_PER_WINDOW} orders on ${dayString(start)}, which one sync cannot read yet`,
          );
        }
      }

      return {
        observations: aggregateOrders(orders, start, end, now.toISOString()),
        baskets: basketsOfOrders(orders, start, end),
        cursor: advanceCursor(cursor, end),
        done: end.getTime() === plan.yesterday.getTime(),
      };
    },

    async listProducts(secret): Promise<ExternalProduct[]> {
      const cred = parseShopifyCredential(secret);
      const out: ExternalProduct[] = [];
      let after: string | null = null;
      for (let page = 0; page < SHOPIFY_MAX_PRODUCT_PAGES; page += 1) {
        const data = await graphql(ctx, cred, "products", { after });
        const products = parseConnection(data["products"], "products");
        for (const node of products.nodes) {
          const p = node as { id?: unknown; title?: unknown; status?: unknown };
          if (typeof p?.id !== "string" || typeof p.title !== "string") {
            throw new ProviderError("shopify: a product is missing its id or title");
          }
          out.push({
            ref: p.id,
            title: p.title,
            status: typeof p.status === "string" ? p.status : null,
          });
        }
        if (!products.hasNextPage) return out;
        after = products.endCursor;
      }
      throw new ProviderError("shopify: more products than one listing reads");
    },

    async readStock(secret, now): Promise<StockRead> {
      const cred = parseShopifyCredential(secret);
      const products: ShopifyStockProduct[] = [];
      let after: string | null = null;
      for (let page = 0; page < SHOPIFY_MAX_STOCK_PAGES; page += 1) {
        const data = await graphql(ctx, cred, "stock", {
          first: SHOPIFY_STOCK_PAGE,
          variants: SHOPIFY_STOCK_VARIANTS,
          after,
        });
        const shop = data["shop"] as { currencyCode?: unknown } | null;
        if (typeof shop?.currencyCode !== "string") {
          throw new ProviderError("shopify: the shop's currency is missing");
        }
        const listed = parseConnection(data["products"], "products");
        products.push(...listed.nodes.map(parseStockProduct));
        if (!listed.hasNextPage) {
          return aggregateStock(products, shop.currencyCode, dayString(now), now.toISOString());
        }
        after = listed.endCursor;
      }
      throw new ProviderError("shopify: more products than one stock read reads");
    },

    async readAbandonedCheckouts(secret, now, days): Promise<CartRead> {
      const cred = parseShopifyCredential(secret);
      const search = `created_at:>='${isoSeconds(addDays(now, -days))}'`;
      const carts: ExternalCart[] = [];
      let after: string | null = null;
      for (let page = 0; page < SHOPIFY_MAX_CART_PAGES; page += 1) {
        const data = await graphql(ctx, cred, "abandoned_checkouts", {
          first: SHOPIFY_CARTS_PAGE,
          lineItems: SHOPIFY_CART_LINES,
          after,
          search,
        });
        const listed = parseConnection(data["abandonedCheckouts"], "abandoned checkouts");
        carts.push(...listed.nodes.map(parseCart));
        if (!listed.hasNextPage) return { carts };
        if (listed.endCursor === null) {
          throw new ProviderError("shopify: hasNextPage without a cursor to continue from");
        }
        after = listed.endCursor;
      }
      // Never a partial count: a short read would understate what was left.
      throw new TooManyCartsError(
        `shopify: more than ${SHOPIFY_CARTS_PAGE * SHOPIFY_MAX_CART_PAGES} checkouts in ${days} days, which one sync cannot read yet`,
      );
    },
  };
}

export const shopifyProvider = createShopifyProvider();
