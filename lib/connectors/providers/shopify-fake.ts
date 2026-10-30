// A recorded-shape Shopify, for tests only (P2-14..16).
//
// Implements the client credentials token exchange and the read queries the
// connector sends, with the behaviour Shopify documents: a 24-hour token
// whose scope readback matches the installation, orders filtered by
// created_at and sorted by CREATED_AT, cursor pagination, nested line item
// pages, and orders older than 60 days HIDDEN unless read_all_orders is
// granted. Abandoned checkouts (idea 47) are filtered by created_at and
// sorted by CREATED_AT, and a document that asks for a checkout's customer
// is refused the way Shopify refuses a type outside the token's scopes
// (Customer "Requires read_customers access scope"), unless the fake was
// given read_customers; with it, the customer's default email and its
// marketingState come back (I-47b), or the protected-data refusal when the
// fake is told Shopify withholds it. Nothing in app code imports this file.

import type {
  ShopifyCredential,
  ShopifyFetch,
  ShopifyRequestInit,
  ShopifyResponse,
} from "./shopify";

export const FAKE_SHOPIFY_CREDENTIAL: ShopifyCredential = {
  shop: "ember-oak.myshopify.com",
  client_id: "fake-client-id",
  client_secret: "shpss_fakeClientSecretForTests",
};

export const FAKE_SHOPIFY_SECRET = JSON.stringify(FAKE_SHOPIFY_CREDENTIAL);

export interface FakeShopifyLine {
  quantity: number;
  productId: string | null;
}

export interface FakeShopifyOrder {
  id: string;
  createdAt: string;
  cancelledAt: string | null;
  test: boolean;
  total: string;
  refunded: string;
  currency: string;
  lines: FakeShopifyLine[];
}

export interface FakeShopifyProduct {
  id: string;
  title: string;
  status: string;
  /**
   * Feature 34: the product's variants as the Stock query returns them.
   * Absent: one untracked variant (a product nobody counts stock for).
   */
  variants?: FakeShopifyVariant[];
}

export interface FakeShopifyVariant {
  /** inventoryQuantity; null when Shopify sends none. */
  quantity: number | null;
  /** Decimal string in the shop's currency, as Shopify sends Money. */
  price: string;
  /** inventoryItem.unitCost.amount; null when no cost is set. */
  cost: string | null;
  tracked?: boolean;
}

/** Idea 47: one abandoned checkout, amounts as Shopify's decimal strings. */
export interface FakeShopifyCart {
  id: string;
  createdAt: string;
  updatedAt?: string;
  completedAt?: string | null;
  total: string;
  currency?: string;
  lines: { title: string | null; quantity: number; price: string; productId: string | null }[];
  /** The shopper's address: Shopify holds it, and shows it only with read_customers. */
  email?: string | null;
  /** defaultEmailAddress.marketingState; default NOT_SUBSCRIBED. */
  marketingState?: string;
  /** defaultEmailAddress.marketingUpdatedAt; default null (never updated). */
  marketingUpdatedAt?: string | null;
}

export interface FakeShopifyCall {
  url: URL;
  init: ShopifyRequestInit;
  /** The GraphQL document, for calls to graphql.json. */
  query: string | null;
}

export interface FakeShopifyOptions {
  orders?: FakeShopifyOrder[];
  products?: FakeShopifyProduct[];
  carts?: FakeShopifyCart[];
  scopes?: string[];
  /**
   * I-47b: Shopify withholds protected customer data even from a token with
   * read_customers, as for an app not approved for it.
   */
  customerDataWithheld?: boolean;
  /** The shop's currency (shop.currencyCode). Default EUR. */
  currency?: string;
  /** The clock Shopify's 60-day rule is measured against. */
  now?: Date;
  respond?: (call: FakeShopifyCall, n: number) => ShopifyResponse | null;
}

export interface FakeShopify {
  fetch: ShopifyFetch;
  calls: FakeShopifyCall[];
  orders: FakeShopifyOrder[];
}

export function shopifyJson(status: number, body: unknown): ShopifyResponse {
  return { status, json: async () => body };
}

const FAKE_TOKEN = "shpat_fakeAccessToken";

function moneyBag(amount: string, currencyCode: string) {
  return { shopMoney: { amount, currencyCode } };
}

function lineNodes(lines: FakeShopifyLine[]) {
  return lines.map((l) => ({
    currentQuantity: l.quantity,
    product: l.productId === null ? null : { id: l.productId },
  }));
}

export function fakeShopify(options: FakeShopifyOptions = {}): FakeShopify {
  const orders = options.orders ?? [];
  const products = options.products ?? [];
  const scopes = options.scopes ?? ["read_orders", "read_products"];
  const now = options.now ?? new Date();
  const calls: FakeShopifyCall[] = [];

  const fetch: ShopifyFetch = async (url, init) => {
    const u = new URL(url);
    let query: string | null = null;
    let variables: Record<string, unknown> = {};
    if (u.pathname.endsWith("/graphql.json")) {
      const parsed = JSON.parse(init.body) as {
        query: string;
        variables?: Record<string, unknown>;
      };
      query = parsed.query;
      variables = parsed.variables ?? {};
    }
    const call: FakeShopifyCall = { url: u, init, query };
    calls.push(call);

    const forced = options.respond?.(call, calls.length) ?? null;
    if (forced !== null) return forced;

    if (u.pathname === "/admin/oauth/access_token") {
      const form = new URLSearchParams(init.body);
      if (
        form.get("grant_type") !== "client_credentials" ||
        form.get("client_id") !== FAKE_SHOPIFY_CREDENTIAL.client_id ||
        form.get("client_secret") !== FAKE_SHOPIFY_CREDENTIAL.client_secret
      ) {
        return shopifyJson(400, { error: "invalid_client" });
      }
      return shopifyJson(200, {
        access_token: FAKE_TOKEN,
        scope: scopes.join(","),
        expires_in: 86399,
      });
    }

    if (init.headers["x-shopify-access-token"] !== FAKE_TOKEN) {
      return shopifyJson(401, { errors: "Invalid API key or access token" });
    }

    if (query?.startsWith("query AccessScopes")) {
      return shopifyJson(200, {
        data: { currentAppInstallation: { accessScopes: scopes.map((handle) => ({ handle })) } },
      });
    }

    if (query?.startsWith("query Orders")) {
      const search = String(variables["search"] ?? "");
      const gte = /created_at:>='([^']+)'/.exec(search)?.[1];
      const lt = /created_at:<'([^']+)'/.exec(search)?.[1];
      const visibleFrom = scopes.includes("read_all_orders")
        ? -Infinity
        : now.getTime() - 60 * 86_400_000;
      const matching = orders
        .filter((o) => {
          const at = Date.parse(o.createdAt);
          return (
            at >= visibleFrom &&
            (gte === undefined || at >= Date.parse(gte)) &&
            (lt === undefined || at < Date.parse(lt))
          );
        })
        .sort(
          (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || (a.id < b.id ? -1 : 1),
        );
      const first = Number(variables["first"]);
      const lineFirst = Number(variables["lineItems"]);
      const after = variables["after"];
      const startIndex = typeof after === "string" ? Number(after) : 0;
      const page = matching.slice(startIndex, startIndex + first);
      const next = startIndex + page.length;
      return shopifyJson(200, {
        data: {
          orders: {
            nodes: page.map((o) => ({
              id: o.id,
              createdAt: o.createdAt,
              cancelledAt: o.cancelledAt,
              test: o.test,
              totalPriceSet: moneyBag(o.total, o.currency),
              totalRefundedSet: moneyBag(o.refunded, o.currency),
              lineItems: {
                nodes: lineNodes(o.lines.slice(0, lineFirst)),
                pageInfo: {
                  hasNextPage: o.lines.length > lineFirst,
                  endCursor: o.lines.length > lineFirst ? String(lineFirst) : null,
                },
              },
            })),
            pageInfo: {
              hasNextPage: next < matching.length,
              endCursor: next < matching.length ? String(next) : null,
            },
          },
        },
        extensions: {
          cost: {
            requestedQueryCost: first + first * lineFirst,
            actualQueryCost: page.length,
            throttleStatus: { maximumAvailable: 2000, currentlyAvailable: 1900, restoreRate: 100 },
          },
        },
      });
    }

    if (query?.startsWith("query OrderLineItems")) {
      const order = orders.find((o) => o.id === variables["id"]);
      if (!order) return shopifyJson(200, { data: { order: null } });
      const from = Number(variables["after"] ?? 0);
      const page = order.lines.slice(from, from + 250);
      const next = from + page.length;
      return shopifyJson(200, {
        data: {
          order: {
            lineItems: {
              nodes: lineNodes(page),
              pageInfo: {
                hasNextPage: next < order.lines.length,
                endCursor: next < order.lines.length ? String(next) : null,
              },
            },
          },
        },
      });
    }

    if (query?.startsWith("query Stock")) {
      const after = variables["after"];
      const first = Number(variables["first"]);
      const variantFirst = Number(variables["variants"]);
      const from = typeof after === "string" ? Number(after) : 0;
      const page = products.slice(from, from + first);
      const next = from + page.length;
      const currency = options.currency ?? "EUR";
      return shopifyJson(200, {
        data: {
          shop: { currencyCode: currency },
          products: {
            nodes: page.map((p) => {
              const variants = p.variants ?? [
                { quantity: null, price: "0.00", cost: null, tracked: false },
              ];
              return {
                id: p.id,
                title: p.title,
                variants: {
                  nodes: variants.slice(0, variantFirst).map((v) => ({
                    inventoryQuantity: v.quantity,
                    price: v.price,
                    inventoryItem: {
                      tracked: v.tracked ?? true,
                      unitCost: v.cost === null ? null : { amount: v.cost, currencyCode: currency },
                    },
                  })),
                  pageInfo: { hasNextPage: variants.length > variantFirst },
                },
              };
            }),
            pageInfo: {
              hasNextPage: next < products.length,
              endCursor: next < products.length ? String(next) : null,
            },
          },
        },
      });
    }

    if (query?.startsWith("query AbandonedCheckouts")) {
      const asksCustomer = /\bcustomer\b/.test(query);
      if (asksCustomer && options.customerDataWithheld && scopes.includes("read_customers")) {
        return shopifyJson(200, {
          data: null,
          errors: [
            {
              message: "This app is not approved to access the Customer object.",
              extensions: { code: "ACCESS_DENIED" },
            },
          ],
        });
      }
      if (asksCustomer && !scopes.includes("read_customers")) {
        return shopifyJson(200, {
          data: null,
          errors: [
            {
              message:
                "Access denied for customer field. Required access: `read_customers` access scope.",
              extensions: { code: "ACCESS_DENIED" },
            },
          ],
        });
      }
      const carts = options.carts ?? [];
      const search = String(variables["search"] ?? "");
      const gte = /created_at:>='([^']+)'/.exec(search)?.[1];
      const matching = carts
        // A checkout not yet started (the demo seed moves the clock) isn't there to read.
        .filter((c) => Date.parse(c.createdAt) <= Date.now())
        .filter((c) => gte === undefined || Date.parse(c.createdAt) >= Date.parse(gte))
        .sort(
          (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || (a.id < b.id ? -1 : 1),
        );
      const first = Number(variables["first"]);
      const lineFirst = Number(variables["lineItems"]);
      const after = variables["after"];
      const startIndex = typeof after === "string" ? Number(after) : 0;
      const page = matching.slice(startIndex, startIndex + first);
      const next = startIndex + page.length;
      return shopifyJson(200, {
        data: {
          abandonedCheckouts: {
            nodes: page.map((c) => {
              const currency = c.currency ?? options.currency ?? "EUR";
              return {
                id: c.id,
                createdAt: c.createdAt,
                updatedAt: c.updatedAt ?? c.createdAt,
                completedAt: c.completedAt ?? null,
                ...(asksCustomer
                  ? {
                      customer: c.email
                        ? {
                            defaultEmailAddress: {
                              emailAddress: c.email,
                              marketingState: c.marketingState ?? "NOT_SUBSCRIBED",
                              marketingUpdatedAt: c.marketingUpdatedAt ?? null,
                            },
                          }
                        : null,
                    }
                  : {}),
                totalPriceSet: moneyBag(c.total, currency),
                lineItems: {
                  nodes: c.lines.slice(0, lineFirst).map((l) => ({
                    title: l.title,
                    quantity: l.quantity,
                    originalUnitPriceSet: moneyBag(l.price, currency),
                    product: l.productId === null ? null : { id: l.productId },
                  })),
                  pageInfo: { hasNextPage: c.lines.length > lineFirst },
                },
              };
            }),
            pageInfo: {
              hasNextPage: next < matching.length,
              endCursor: next < matching.length ? String(next) : null,
            },
          },
        },
      });
    }

    if (query?.startsWith("query Products")) {
      const after = variables["after"];
      const from = typeof after === "string" ? Number(after) : 0;
      const page = products.slice(from, from + 250);
      const next = from + page.length;
      return shopifyJson(200, {
        data: {
          products: {
            nodes: page.map((p) => ({ id: p.id, title: p.title, status: p.status })),
            pageInfo: {
              hasNextPage: next < products.length,
              endCursor: next < products.length ? String(next) : null,
            },
          },
        },
      });
    }

    return shopifyJson(200, { errors: [{ message: "unknown query in fake" }] });
  };

  return { fetch, calls, orders };
}

let sequence = 0;

/** One order. Amounts are decimal strings, as Shopify sends them. */
export function shopOrder(
  createdAt: string,
  total: string,
  lines: FakeShopifyLine[] = [],
  extra: Partial<Pick<FakeShopifyOrder, "refunded" | "currency" | "cancelledAt" | "test">> = {},
): FakeShopifyOrder {
  sequence += 1;
  return {
    id: `gid://shopify/Order/${sequence}`,
    createdAt,
    cancelledAt: extra.cancelledAt ?? null,
    test: extra.test ?? false,
    total,
    refunded: extra.refunded ?? "0.00",
    currency: extra.currency ?? "EUR",
    lines,
  };
}

let cartSequence = 0;

/** Idea 47: one abandoned checkout. Amounts are decimal strings, as Shopify sends them. */
export function shopCart(
  createdAt: string,
  total: string,
  lines: FakeShopifyCart["lines"] = [],
  extra: Partial<
    Pick<
      FakeShopifyCart,
      "completedAt" | "currency" | "email" | "marketingState" | "marketingUpdatedAt" | "updatedAt"
    >
  > = {},
): FakeShopifyCart {
  cartSequence += 1;
  return {
    id: `gid://shopify/AbandonedCheckout/${cartSequence}`,
    createdAt,
    total,
    lines,
    ...extra,
  };
}
