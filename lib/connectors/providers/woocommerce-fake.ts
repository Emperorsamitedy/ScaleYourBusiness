// A recorded-shape WooCommerce, for tests only (P2-17).
//
// Implements the two GET list endpoints the connector calls, with the REST
// API's documented behaviour: HTTP basic auth, after/before date filters
// (after is exclusive), page and per_page (up to 100), and the
// X-WP-Total / X-WP-TotalPages headers. Nothing in app code imports this.

import type { WooFetch, WooRequestInit, WooResponse } from "./woocommerce";

export const FAKE_WOO_CREDENTIAL = {
  site_url: "https://shop.example.com",
  consumer_key: "ck_fakeConsumerKeyForTests",
  consumer_secret: "cs_fakeConsumerSecretForTests",
};

export const FAKE_WOO_SECRET = JSON.stringify(FAKE_WOO_CREDENTIAL);

export interface FakeWooOrder {
  id: number;
  status: string;
  currency: string;
  total: string;
  date_created_gmt: string;
  refunds: { total: string }[];
  line_items: { product_id: number; quantity: number }[];
}

export interface FakeWooProduct {
  id: number;
  name: string;
  status: string;
  /** Feature 34: the stock fields the product list carries, when set. */
  manage_stock?: boolean;
  stock_quantity?: number | null;
  price?: string;
}

export interface FakeWooCall {
  url: URL;
  init: WooRequestInit;
}

export interface FakeWoo {
  fetch: WooFetch;
  calls: FakeWooCall[];
  orders: FakeWooOrder[];
}

export function wooJson(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): WooResponse {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { status, json: async () => body, header: (name) => lower[name.toLowerCase()] ?? null };
}

export function fakeWoo(
  options: {
    orders?: FakeWooOrder[];
    products?: FakeWooProduct[];
    respond?: (call: FakeWooCall, n: number) => WooResponse | null;
  } = {},
): FakeWoo {
  const orders = options.orders ?? [];
  const products = options.products ?? [];
  const calls: FakeWooCall[] = [];
  const expectedAuth = `Basic ${Buffer.from(
    `${FAKE_WOO_CREDENTIAL.consumer_key}:${FAKE_WOO_CREDENTIAL.consumer_secret}`,
  ).toString("base64")}`;

  const fetch: WooFetch = async (url, init) => {
    const call: FakeWooCall = { url: new URL(url), init };
    calls.push(call);
    const forced = options.respond?.(call, calls.length) ?? null;
    if (forced !== null) return forced;

    if (init.headers["authorization"] !== expectedAuth) {
      return wooJson(401, {
        code: "woocommerce_rest_cannot_view",
        message: "Sorry, you cannot list resources.",
      });
    }

    const params = call.url.searchParams;
    const perPage = Math.min(100, Math.max(1, Number(params.get("per_page") ?? "10")));
    const page = Math.max(1, Number(params.get("page") ?? "1"));
    const paginate = <T>(rows: T[]) => {
      const totalPages = Math.ceil(rows.length / perPage);
      return wooJson(200, rows.slice((page - 1) * perPage, page * perPage), {
        "X-WP-Total": String(rows.length),
        "X-WP-TotalPages": String(totalPages),
      });
    };

    if (call.url.pathname === "/wp-json/wc/v3/orders") {
      const after = params.get("after");
      const before = params.get("before");
      const at = (s: string) => Date.parse(`${s}Z`);
      const rows = orders
        .filter(
          (o) =>
            (after === null || at(o.date_created_gmt) > at(after)) &&
            (before === null || at(o.date_created_gmt) < at(before)),
        )
        .sort((a, b) => at(a.date_created_gmt) - at(b.date_created_gmt) || a.id - b.id);
      return paginate(rows);
    }
    if (call.url.pathname === "/wp-json/wc/v3/products") {
      return paginate(products);
    }
    return wooJson(404, { code: "rest_no_route", message: "No route was found matching the URL" });
  };

  return { fetch, calls, orders };
}

let sequence = 0;

export function wooOrder(
  dateCreatedGmt: string,
  total: string,
  lineItems: { product_id: number; quantity: number }[] = [],
  extra: Partial<Pick<FakeWooOrder, "status" | "currency" | "refunds">> = {},
): FakeWooOrder {
  sequence += 1;
  return {
    id: sequence,
    status: extra.status ?? "completed",
    currency: extra.currency ?? "EUR",
    total,
    date_created_gmt: dateCreatedGmt,
    refunds: extra.refunds ?? [],
    line_items: lineItems,
  };
}
