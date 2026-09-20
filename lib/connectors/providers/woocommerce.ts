// The WooCommerce connector — Phase 2 Session C (P2-17).
//
// The same contract as Shopify, on a very different platform: a REST API on
// the owner's own WordPress site, HTTP basic auth, page-numbered lists. If
// the provider interface carries both without special cases, it will carry
// the ad platforms too; that is what this task proves.
//
// READ-ONLY, AS FAR AS CAN BE PROVEN. WooCommerce keys are created with
// Read, Write or Read/Write access, and nothing in its REST API reports
// which, so this is the Stripe situation (scopeVerification: "probed").
// Every read the connector needs is proven at connect time; this module
// can only issue GET requests, to paths in WOO_READ_ENDPOINTS, guarded at
// the type level, at runtime, and by a source scan in woocommerce.test.ts;
// and the connect screen asks the owner to create a Read key.
//
// THE ADDRESS IS OWNER-TYPED, so it is validated before any request: https
// only, no credentials in it, a real public hostname, never an IP literal,
// localhost or an internal name. This server must not be pointed at
// itself. A hostname that resolves to a private address is not caught here;
// the platform's network egress rules are the layer for that.
//
// THE ARITHMETIC. Revenue for a day is the total of orders created that day
// plus their refunds (WooCommerce refund totals are negative), counting
// processing, completed, on-hold and refunded orders. Pending, failed,
// cancelled and draft orders are not sales. Every sync re-reads the last 30
// days, because refunds change past orders. Units are line item quantities
// by product id.

import { addDays, advanceCursor, dayString, oneNewDay, planWindow } from "../days";
import { DecimalError, decimalToMinor } from "../decimal";
import type { ExternalProduct, Observation, Provider, PullPage } from "../provider";
import { ProviderError } from "../provider";

/** Every path this module may call, keyed by the registry capability it proves. */
export const WOO_READ_ENDPOINTS = {
  read_orders: "/wp-json/wc/v3/orders",
  read_products: "/wp-json/wc/v3/products",
} as const;

export const WOO_BACKFILL_DAYS = 365;
export const WOO_WINDOW_DAYS = 30;
export const WOO_REREAD_DAYS = 30;
export const WOO_PAGE_SIZE = 100;
export const WOO_MAX_PAGES_PER_WINDOW = 50;
export const WOO_MAX_PRODUCT_PAGES = 100;
export const WOO_MAX_ATTEMPTS = 3;

/** Order statuses that are sales. */
export const WOO_COUNTED_STATUSES: ReadonlySet<string> = new Set([
  "processing",
  "completed",
  "on-hold",
  "refunded",
]);

export interface WooRequestInit {
  /** The only verb the type admits. */
  method: "GET";
  headers: Record<string, string>;
}

export interface WooResponse {
  status: number;
  json(): Promise<unknown>;
  header(name: string): string | null;
}

export type WooFetch = (url: string, init: WooRequestInit) => Promise<WooResponse>;

export interface WooProviderOptions {
  fetch?: WooFetch;
  sleep?: (ms: number) => Promise<void>;
}

export interface WooCredential {
  /** https origin plus any WordPress sub-path, without a trailing slash. */
  base: string;
  consumer_key: string;
  consumer_secret: string;
}

/** True for a hostname this server must never call. */
export function isForbiddenHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".lan")) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return true; // IPv4 literal
  if (h.includes(":") || h.startsWith("[")) return true; // IPv6 literal
  if (!h.includes(".")) return true; // single-label intranet names
  return false;
}

export function parseWooCredential(secret: string): WooCredential {
  let raw: unknown;
  try {
    raw = JSON.parse(secret);
  } catch {
    throw new ProviderError(
      "woocommerce: the store address, consumer key and consumer secret are all needed",
    );
  }
  const c = (raw ?? {}) as Record<string, unknown>;
  const site = typeof c["site_url"] === "string" ? c["site_url"].trim() : "";
  let url: URL;
  try {
    url = new URL(site);
  } catch {
    throw new ProviderError(
      "woocommerce: the store address must be a full address, like https://your-store.com",
    );
  }
  if (url.protocol !== "https:") {
    throw new ProviderError("woocommerce: the store address must start with https://");
  }
  if (url.username !== "" || url.password !== "") {
    throw new ProviderError(
      "woocommerce: the store address must not contain a username or password",
    );
  }
  if (isForbiddenHost(url.hostname)) {
    throw new ProviderError(
      "woocommerce: the store address must be your store's public web address",
    );
  }
  const consumer_key = typeof c["consumer_key"] === "string" ? c["consumer_key"].trim() : "";
  const consumer_secret =
    typeof c["consumer_secret"] === "string" ? c["consumer_secret"].trim() : "";
  if (!consumer_key.startsWith("ck_") || !consumer_secret.startsWith("cs_")) {
    throw new ProviderError(
      "woocommerce: the consumer key starts with ck_ and the consumer secret with cs_",
    );
  }
  return {
    base: `${url.origin}${url.pathname.replace(/\/+$/, "")}`,
    consumer_key,
    consumer_secret,
  };
}

interface Context {
  fetch: WooFetch;
  sleep: (ms: number) => Promise<void>;
}

const READ_PATHS: readonly string[] = Object.values(WOO_READ_ENDPOINTS);

function backoffMs(attempt: number): number {
  return 500 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);
}

async function wooGet(
  ctx: Context,
  cred: WooCredential,
  path: string,
  params: Record<string, string>,
): Promise<{ body: unknown; totalPages: number | null }> {
  if (!READ_PATHS.includes(path)) {
    throw new ProviderError(
      `woocommerce: refusing to call ${path}, which is not a registered read`,
    );
  }
  const url = `${cred.base}${path}?${new URLSearchParams(params).toString()}`;
  const auth = Buffer.from(`${cred.consumer_key}:${cred.consumer_secret}`).toString("base64");

  for (let attempt = 1; ; attempt += 1) {
    let response: WooResponse;
    try {
      response = await ctx.fetch(url, {
        method: "GET",
        headers: { authorization: `Basic ${auth}`, accept: "application/json" },
      });
    } catch {
      if (attempt >= WOO_MAX_ATTEMPTS) {
        throw new ProviderError(`woocommerce: network failure after ${attempt} attempts`);
      }
      await ctx.sleep(backoffMs(attempt));
      continue;
    }

    if (response.status === 200) {
      const pages = Number(response.header("x-wp-totalpages"));
      return {
        body: await response.json(),
        totalPages: Number.isSafeInteger(pages) && pages >= 0 ? pages : null,
      };
    }
    const body = (await response.json().catch(() => null)) as { message?: unknown } | null;
    const message = typeof body?.message === "string" ? body.message : null;
    if (response.status === 401) {
      throw new ProviderError(
        "woocommerce: that key was not accepted. It may be mistyped or revoked",
      );
    }
    if (response.status === 403) {
      throw new ProviderError(
        `woocommerce: the key is missing a read permission${message ? `. The store says: ${message}` : ""}`,
      );
    }
    if (response.status === 404) {
      throw new ProviderError(
        "woocommerce: the WooCommerce REST API wasn't found at this address. Check the store address",
      );
    }
    if ((response.status === 429 || response.status >= 500) && attempt < WOO_MAX_ATTEMPTS) {
      await ctx.sleep(backoffMs(attempt));
      continue;
    }
    throw new ProviderError(
      `woocommerce: request failed with status ${response.status}${message ? `. ${message}` : ""}`,
    );
  }
}

/* ── parsing ── */

export interface WooOrder {
  id: number;
  status: string;
  currency: string;
  total: string;
  /** "YYYY-MM-DDTHH:MM:SS", in GMT. */
  dateCreatedGmt: string;
  refunds: string[];
  lines: { productId: number; quantity: number }[];
}

function parseOrder(value: unknown): WooOrder {
  const o = value as {
    id?: unknown;
    status?: unknown;
    currency?: unknown;
    total?: unknown;
    date_created_gmt?: unknown;
    refunds?: unknown;
    line_items?: unknown;
  } | null;
  if (
    !o ||
    typeof o.id !== "number" ||
    typeof o.status !== "string" ||
    typeof o.currency !== "string" ||
    typeof o.total !== "string" ||
    typeof o.date_created_gmt !== "string"
  ) {
    throw new ProviderError("woocommerce: an order is missing a field the connector relies on");
  }
  const refunds = Array.isArray(o.refunds)
    ? o.refunds.map((r) => {
        const total = (r as { total?: unknown } | null)?.total;
        if (typeof total !== "string")
          throw new ProviderError("woocommerce: a refund has no total");
        return total;
      })
    : [];
  const lines = Array.isArray(o.line_items)
    ? o.line_items.map((l) => {
        const line = l as { product_id?: unknown; quantity?: unknown } | null;
        if (!line || typeof line.product_id !== "number" || !Number.isSafeInteger(line.quantity)) {
          throw new ProviderError("woocommerce: a line item is missing its product or quantity");
        }
        return { productId: line.product_id, quantity: line.quantity as number };
      })
    : [];
  return {
    id: o.id,
    status: o.status,
    currency: o.currency,
    total: o.total,
    dateCreatedGmt: o.date_created_gmt,
    refunds,
    lines,
  };
}

const gmt = (d: Date): string => d.toISOString().slice(0, 19);

async function fetchOrders(
  ctx: Context,
  cred: WooCredential,
  start: Date,
  end: Date,
): Promise<WooOrder[] | "too_many"> {
  const out: WooOrder[] = [];
  for (let page = 1; page <= WOO_MAX_PAGES_PER_WINDOW; page += 1) {
    const { body, totalPages } = await wooGet(ctx, cred, WOO_READ_ENDPOINTS.read_orders, {
      per_page: String(WOO_PAGE_SIZE),
      page: String(page),
      // "after" is exclusive: one second earlier makes the start inclusive.
      after: gmt(new Date(start.getTime() - 1000)),
      before: gmt(addDays(end, 1)),
      dates_are_gmt: "true",
      orderby: "date",
      order: "asc",
    });
    if (!Array.isArray(body))
      throw new ProviderError("woocommerce: unexpected orders response shape");
    out.push(...body.map(parseOrder));
    const lastPage = totalPages === null ? body.length < WOO_PAGE_SIZE : page >= totalPages;
    if (lastPage || body.length === 0) return out;
  }
  return "too_many";
}

/* ── arithmetic ── */

export function aggregateWooOrders(
  orders: readonly WooOrder[],
  start: Date,
  end: Date,
  observedAt: string,
): Observation[] {
  const revenue = new Map<string, Map<string, number>>();
  const counts = new Map<string, number>();
  const units = new Map<string, Map<string, number>>();
  const currencies = new Set<string>();
  const from = start.getTime();
  const until = addDays(end, 1).getTime();

  for (const o of orders) {
    if (!WOO_COUNTED_STATUSES.has(o.status)) continue;
    const at = Date.parse(`${o.dateCreatedGmt}Z`);
    if (!Number.isFinite(at) || at < from || at >= until) continue;
    const day = dayString(new Date(at));
    const currency = o.currency.toUpperCase();
    let net: number;
    try {
      net = decimalToMinor(o.total, currency);
      for (const refund of o.refunds) net += decimalToMinor(refund, currency);
    } catch (error) {
      if (error instanceof DecimalError) {
        throw new ProviderError(`woocommerce: order ${o.id}: ${error.message}`);
      }
      throw error;
    }
    currencies.add(currency);
    const byCurrency = revenue.get(day) ?? new Map<string, number>();
    byCurrency.set(currency, (byCurrency.get(currency) ?? 0) + net);
    revenue.set(day, byCurrency);
    counts.set(day, (counts.get(day) ?? 0) + 1);

    for (const line of o.lines) {
      if (line.productId <= 0 || line.quantity <= 0) continue;
      const ref = String(line.productId);
      const byProduct = units.get(day) ?? new Map<string, number>();
      byProduct.set(ref, (byProduct.get(ref) ?? 0) + line.quantity);
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
      for (const [ref, quantity] of [...byProduct.entries()].sort(([a], [b]) =>
        a < b ? -1 : a > b ? 1 : 0,
      )) {
        out.push({
          metric_key: "units.daily",
          period_date: day,
          dimensions: { product_ref: ref },
          value_num: quantity,
          observed_at: observedAt,
        });
      }
    }
  }
  return out;
}

/* ── the provider ── */

const defaultFetch: WooFetch = async (url, init) => {
  const response = await fetch(url, {
    method: init.method,
    headers: init.headers,
    cache: "no-store",
    redirect: "error",
  });
  return {
    status: response.status,
    json: () => response.json() as Promise<unknown>,
    header: (name) => response.headers.get(name),
  };
};

export function createWooCommerceProvider(options: WooProviderOptions = {}): Provider {
  const ctx: Context = {
    fetch: options.fetch ?? defaultFetch,
    sleep: options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
  };

  return {
    id: "woocommerce",
    label: "WooCommerce",
    scopeVerification: "probed",

    async connect(secret) {
      const cred = parseWooCredential(secret);
      // Prove each read we need. per_page=1: a credential check, not a sync.
      for (const path of READ_PATHS) {
        const { body } = await wooGet(ctx, cred, path, { per_page: "1" });
        if (!Array.isArray(body)) {
          throw new ProviderError("woocommerce: unexpected response shape");
        }
      }
      return { granted_scopes: Object.keys(WOO_READ_ENDPOINTS) };
    },

    async pull(secret, cursor, now): Promise<PullPage> {
      const cred = parseWooCredential(secret);
      const plan = planWindow({
        cursor,
        now,
        historyDays: WOO_BACKFILL_DAYS,
        rereadDays: WOO_REREAD_DAYS,
        windowDays: WOO_WINDOW_DAYS,
        provider: "woocommerce",
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
            `woocommerce: more than ${WOO_PAGE_SIZE * WOO_MAX_PAGES_PER_WINDOW} orders on ${dayString(start)}, which one sync cannot read yet`,
          );
        }
      }
      return {
        observations: aggregateWooOrders(orders, start, end, now.toISOString()),
        cursor: advanceCursor(cursor, end),
        done: end.getTime() === plan.yesterday.getTime(),
      };
    },

    async listProducts(secret): Promise<ExternalProduct[]> {
      const cred = parseWooCredential(secret);
      const out: ExternalProduct[] = [];
      for (let page = 1; page <= WOO_MAX_PRODUCT_PAGES; page += 1) {
        const { body, totalPages } = await wooGet(ctx, cred, WOO_READ_ENDPOINTS.read_products, {
          per_page: String(WOO_PAGE_SIZE),
          page: String(page),
        });
        if (!Array.isArray(body)) {
          throw new ProviderError("woocommerce: unexpected products response shape");
        }
        for (const item of body) {
          const p = item as { id?: unknown; name?: unknown; status?: unknown } | null;
          if (!p || typeof p.id !== "number" || typeof p.name !== "string") {
            throw new ProviderError("woocommerce: a product is missing its id or name");
          }
          out.push({
            ref: String(p.id),
            title: p.name,
            status: typeof p.status === "string" ? p.status : null,
          });
        }
        const lastPage = totalPages === null ? body.length < WOO_PAGE_SIZE : page >= totalPages;
        if (lastPage || body.length === 0) return out;
      }
      throw new ProviderError("woocommerce: more products than one listing reads");
    },
  };
}

export const woocommerceProvider = createWooCommerceProvider();
