// P2-14..16 — the Shopify connector, against a recorded-shape Shopify.
//
// No network and no Shopify store: providers/shopify-fake.ts implements the
// token exchange and the read queries the connector sends, including
// Shopify's rule that orders older than 60 days are hidden without
// read_all_orders. What these tests hold:
//
//   · READ-ONLY, PROVEN. Shopify reports a token's scopes, so a write scope
//     is refused for real; every request is the token exchange or a fixed
//     read query to the store's own myshopify.com host; and the source
//     contains no other kind of document.
//   · THE ADDRESS GUARD. Nothing is ever sent to a host that isn't a
//     *.myshopify.com store.
//   · THE ARITHMETIC. Refunds netted, cancelled and test orders excluded,
//     UTC days, currencies apart, units per product.
//   · HISTORY AND SYNC. 60 days or a year depending on the scope, pages
//     and nested line items followed, the last 30 days re-read.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Observation, Provider, PullPage } from "./provider";
import { ProviderError } from "./provider";
import type { ShopifyOrder } from "./providers/shopify";
import {
  SHOPIFY_API_VERSION,
  SHOPIFY_DEFAULT_HISTORY_DAYS,
  SHOPIFY_FULL_HISTORY_DAYS,
  SHOPIFY_MAX_ATTEMPTS,
  SHOPIFY_QUERIES,
  SHOPIFY_REREAD_DAYS,
  aggregateOrders,
  createShopifyProvider,
  parseShopifyCredential,
} from "./providers/shopify";
import type { FakeShopify, FakeShopifyOptions } from "./providers/shopify-fake";
import {
  FAKE_SHOPIFY_CREDENTIAL,
  FAKE_SHOPIFY_SECRET,
  fakeShopify,
  shopOrder,
  shopifyJson,
} from "./providers/shopify-fake";
import { ScopeViolationError, verifyGrantedScopes } from "./scopes";

const NOW = new Date("2026-09-14T12:00:00Z");
const P1 = "gid://shopify/Product/1";
const P2 = "gid://shopify/Product/2";

function shopify(
  options: FakeShopifyOptions = {},
  sleeps: number[] = [],
): { fake: FakeShopify; provider: Provider } {
  const fake = fakeShopify({ now: NOW, ...options });
  const provider = createShopifyProvider({
    fetch: fake.fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { fake, provider };
}

async function runToDone(provider: Provider, cursor: string | null = null): Promise<PullPage[]> {
  const pages: PullPage[] = [];
  let at = cursor;
  for (let i = 0; i < 100; i += 1) {
    const page = await provider.pull(FAKE_SHOPIFY_SECRET, at, NOW);
    pages.push(page);
    at = page.cursor;
    if (page.done) break;
  }
  return pages;
}

const revenueOf = (obs: readonly Observation[], currency: string): number =>
  obs
    .filter((o) => o.metric_key === "revenue.daily" && o.dimensions.currency === currency)
    .reduce((sum, o) => sum + (o.value_minor ?? 0), 0);

const ordersOf = (obs: readonly Observation[]): number =>
  obs.filter((o) => o.metric_key === "orders.daily").reduce((s, o) => s + (o.value_num ?? 0), 0);

const unitsOf = (obs: readonly Observation[], ref: string): number =>
  obs
    .filter((o) => o.metric_key === "units.daily" && o.dimensions.product_ref === ref)
    .reduce((s, o) => s + (o.value_num ?? 0), 0);

const orderDays = (obs: readonly Observation[]): string[] =>
  obs.filter((o) => o.metric_key === "orders.daily").map((o) => o.period_date);

const secretWith = (overrides: Record<string, string>): string =>
  JSON.stringify({ ...FAKE_SHOPIFY_CREDENTIAL, ...overrides });

describe("P2-14 — the credential and the address guard", () => {
  it("normalises the store address someone might paste", () => {
    expect(
      parseShopifyCredential(secretWith({ shop: " https://Ember-Oak.myshopify.com/admin/orders " }))
        .shop,
    ).toBe("ember-oak.myshopify.com");
  });

  it("refuses every address that isn't a myshopify.com store", () => {
    for (const shop of [
      "evil.com",
      "ember-oak.myshopify.com.evil.com",
      "localhost",
      "169.254.169.254",
      "myshopify.com",
      "",
    ]) {
      expect(() => parseShopifyCredential(secretWith({ shop })), shop).toThrow(/myshopify\.com/);
    }
  });

  it("refuses a missing client ID or secret, and anything that isn't the three fields", () => {
    expect(() => parseShopifyCredential(secretWith({ client_secret: " " }))).toThrow(
      /client ID and the client secret/,
    );
    expect(() => parseShopifyCredential("shpat_just_a_token")).toThrow(ProviderError);
  });

  it("an address that fails the guard sends no request at all", async () => {
    const { fake, provider } = shopify();
    await expect(provider.connect(secretWith({ shop: "evil.com" }))).rejects.toThrow(ProviderError);
    await expect(provider.pull(secretWith({ shop: "evil.com" }), null, NOW)).rejects.toThrow(
      ProviderError,
    );
    expect(fake.calls).toHaveLength(0);
  });
});

describe("P2-14 — connecting reads the real scopes", () => {
  it("exchanges the client credentials, then reads the installation's scopes", async () => {
    const { fake, provider } = shopify();
    const result = await provider.connect(FAKE_SHOPIFY_SECRET);

    expect(result.granted_scopes).toEqual(["read_orders", "read_products"]);
    expect(fake.calls.map((c) => c.url.pathname)).toEqual([
      "/admin/oauth/access_token",
      `/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    ]);
    const form = new URLSearchParams(fake.calls[0]?.init.body);
    expect(form.get("grant_type")).toBe("client_credentials");
    expect(fake.calls[1]?.query).toBe(SHOPIFY_QUERIES.access_scopes);
  });

  it("reports read_all_orders when Shopify granted it", async () => {
    const { provider } = shopify({ scopes: ["read_orders", "read_products", "read_all_orders"] });
    expect((await provider.connect(FAKE_SHOPIFY_SECRET)).granted_scopes).toContain(
      "read_all_orders",
    );
  });

  it("refuses an app that is missing a required read, naming it", async () => {
    const { provider } = shopify({ scopes: ["read_orders"] });
    await expect(provider.connect(FAKE_SHOPIFY_SECRET)).rejects.toThrow(/needs read_products/);
  });

  it("RULE 9, FOR REAL: an app with a write scope is refused by the registry check", async () => {
    const { provider } = shopify({ scopes: ["read_orders", "read_products", "write_orders"] });
    const { granted_scopes } = await provider.connect(FAKE_SHOPIFY_SECRET);
    expect(granted_scopes).toContain("write_orders");
    expect(() => verifyGrantedScopes("shopify", granted_scopes)).toThrow(ScopeViolationError);
  });

  it("an app with an unrelated extra read scope is refused too", async () => {
    const { provider } = shopify({ scopes: ["read_orders", "read_products", "read_customers"] });
    const { granted_scopes } = await provider.connect(FAKE_SHOPIFY_SECRET);
    expect(() => verifyGrantedScopes("shopify", granted_scopes)).toThrow(/read_customers/);
  });

  it("wrong credentials are reported as not accepted, and the error never repeats the secret", async () => {
    const { provider } = shopify();
    try {
      await provider.connect(secretWith({ client_secret: "shpss_wrong" }));
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as Error).message).toMatch(/not accepted/);
      expect((error as Error).message).not.toContain("shpss_");
    }
  });
});

describe("rule 9 — the connector can only read", () => {
  it("every request is the token exchange or a registered read query, to the store itself", async () => {
    const { fake, provider } = shopify({
      scopes: ["read_orders", "read_products", "read_all_orders"],
      orders: [shopOrder("2026-03-01T10:00:00Z", "40.00", [{ quantity: 1, productId: P1 }])],
      products: [{ id: P1, title: "Candle", status: "ACTIVE" }],
    });
    await provider.connect(FAKE_SHOPIFY_SECRET);
    await runToDone(provider);
    await provider.listProducts?.(FAKE_SHOPIFY_SECRET);
    await provider.readStock?.(FAKE_SHOPIFY_SECRET, NOW, { currency: null });
    await provider.readAbandonedCheckouts?.(FAKE_SHOPIFY_SECRET, NOW, 60);

    const queries: string[] = Object.values(SHOPIFY_QUERIES);
    expect(fake.calls.length).toBeGreaterThan(10);
    for (const call of fake.calls) {
      expect(call.url.host).toBe(FAKE_SHOPIFY_CREDENTIAL.shop);
      if (call.url.pathname === "/admin/oauth/access_token") continue;
      expect(call.url.pathname).toBe(`/admin/api/${SHOPIFY_API_VERSION}/graphql.json`);
      expect(queries).toContain(call.query);
    }
  });

  it("THE BUILD GATE: the source sends only read queries", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./providers/shopify.ts", import.meta.url)),
      "utf8",
    );
    expect(source).not.toMatch(/mutation/i);
    for (const document of Object.values(SHOPIFY_QUERIES)) {
      expect(document.startsWith("query ")).toBe(true);
    }
    const methods = [...source.matchAll(/method:\s*([^,;\n}]+)/g)].map((m) => m[1]?.trim());
    expect(methods.length).toBeGreaterThan(0);
    for (const method of methods) expect(['"POST"', "init.method"]).toContain(method);
  });

  it("THE LIST: these documents and no others (idea 47 added abandoned_checkouts, nothing else)", () => {
    expect(Object.keys(SHOPIFY_QUERIES)).toEqual([
      "access_scopes",
      "orders",
      "order_line_items",
      "products",
      "stock",
      "abandoned_checkouts",
    ]);
  });
});

describe("P2-16 — the arithmetic", () => {
  const order = (overrides: Partial<ShopifyOrder>): ShopifyOrder => ({
    id: `o-${Math.random()}`,
    createdAt: "2026-09-01T09:00:00Z",
    cancelledAt: null,
    test: false,
    total: "0.00",
    refunded: "0.00",
    currency: "EUR",
    lines: [],
    ...overrides,
  });
  const start = new Date("2026-09-01T00:00:00Z");
  const end = new Date("2026-09-03T00:00:00Z");
  const obs = aggregateOrders(
    [
      order({
        total: "100.00",
        lines: [
          { quantity: 2, productRef: P1 },
          { quantity: 1, productRef: P2 },
        ],
      }),
      order({
        createdAt: "2026-09-01T10:00:00Z",
        total: "50.00",
        refunded: "20.00",
        lines: [{ quantity: 1, productRef: P1 }],
      }),
      order({
        createdAt: "2026-09-01T11:00:00Z",
        total: "999.00",
        cancelledAt: "2026-09-01T12:00:00Z",
      }),
      order({ createdAt: "2026-09-01T12:00:00Z", total: "999.00", test: true }),
      order({
        createdAt: "2026-09-01T23:59:59Z",
        total: "10.00",
        currency: "USD",
        lines: [{ quantity: 1, productRef: null }],
      }),
      order({
        createdAt: "2026-09-02T00:00:00Z",
        total: "30.00",
        refunded: "30.00",
        lines: [{ quantity: 0, productRef: P2 }],
      }),
    ],
    start,
    end,
    NOW.toISOString(),
  );
  const find = (metric: string, day: string, dims: Record<string, string> = {}) =>
    obs.find(
      (o) =>
        o.metric_key === metric &&
        o.period_date === day &&
        o.dimensions.currency === dims["currency"] &&
        o.dimensions.product_ref === dims["product_ref"],
    );

  it("nets refunds, and ignores cancelled and test orders", () => {
    expect(find("revenue.daily", "2026-09-01", { currency: "EUR" })?.value_minor).toBe(
      10_000 + 3_000,
    );
    expect(find("revenue.daily", "2026-09-02", { currency: "EUR" })?.value_minor).toBe(0);
  });

  it("counts orders, including a fully refunded one, and keeps currencies apart", () => {
    expect(find("orders.daily", "2026-09-01")?.value_num).toBe(3);
    expect(find("orders.daily", "2026-09-02")?.value_num).toBe(1);
    expect(find("revenue.daily", "2026-09-01", { currency: "USD" })?.value_minor).toBe(1_000);
  });

  it("sums units per product from current quantities, skipping custom lines and refunded units", () => {
    expect(find("units.daily", "2026-09-01", { product_ref: P1 })?.value_num).toBe(3);
    expect(find("units.daily", "2026-09-01", { product_ref: P2 })?.value_num).toBe(1);
    expect(find("units.daily", "2026-09-02", { product_ref: P2 })).toBeUndefined();
  });

  it("emits zero days for revenue and orders", () => {
    expect(orderDays(obs)).toEqual(["2026-09-01", "2026-09-02", "2026-09-03"]);
    expect(find("orders.daily", "2026-09-03")?.value_num).toBe(0);
  });

  it("P2-27: the same orders per UTC hour, netted, cancelled and test orders left out", () => {
    const hour = (metric: string, h: string, currency?: string) =>
      obs.find(
        (o) =>
          o.metric_key === metric &&
          o.period_date === "2026-09-01" &&
          o.dimensions.hour_utc === h &&
          o.dimensions.currency === currency,
      );
    expect(hour("revenue.hourly", "09", "EUR")?.value_minor).toBe(10_000);
    expect(hour("revenue.hourly", "10", "EUR")?.value_minor).toBe(3_000);
    expect(hour("revenue.hourly", "11", "EUR")).toBeUndefined(); // cancelled
    expect(hour("revenue.hourly", "12", "EUR")).toBeUndefined(); // test
    expect(hour("revenue.hourly", "23", "USD")?.value_minor).toBe(1_000);
    expect(hour("orders.hourly", "09")?.value_num).toBe(1);
    // A fully refunded order is still an order; its revenue nets to nothing.
    const refunded = obs.filter(
      (o) => o.period_date === "2026-09-02" && o.dimensions.hour_utc === "00",
    );
    expect(refunded.map((o) => o.metric_key)).toEqual(["orders.hourly"]);
  });

  it("an amount more precise than the currency is an error naming the order, not a rounding", () => {
    expect(() =>
      aggregateOrders([order({ id: "gid://shopify/Order/9", total: "10.005" })], start, end, "x"),
    ).toThrow(/gid:\/\/shopify\/Order\/9/);
  });
});

describe("P2-16 — history and sync", () => {
  it("without read_all_orders, the backfill reads exactly the 60 days Shopify shows", async () => {
    const { provider } = shopify({
      orders: [
        shopOrder("2026-06-01T10:00:00Z", "500.00"), // older than 60 days: hidden
        shopOrder("2026-09-01T10:00:00Z", "40.00"),
      ],
    });
    const pages = await runToDone(provider);
    const all = pages.flatMap((p) => p.observations);
    const days = orderDays(all);

    expect(days).toHaveLength(SHOPIFY_DEFAULT_HISTORY_DAYS);
    expect(days[0]).toBe("2026-07-16");
    expect(days.at(-1)).toBe("2026-09-13");
    expect(revenueOf(all, "EUR")).toBe(4_000);
    expect(pages.at(-1)).toMatchObject({ cursor: "2026-09-13", done: true });
  });

  it("with read_all_orders, it reads a full year", async () => {
    const { provider } = shopify({
      scopes: ["read_orders", "read_products", "read_all_orders"],
      orders: [
        shopOrder("2026-01-10T10:00:00Z", "500.00"),
        shopOrder("2026-09-01T10:00:00Z", "40.00"),
      ],
    });
    const all = (await runToDone(provider)).flatMap((p) => p.observations);
    expect(orderDays(all)).toHaveLength(SHOPIFY_FULL_HISTORY_DAYS);
    expect(revenueOf(all, "EUR")).toBe(54_000);
  });

  it("follows order pages and nested line item pages", async () => {
    const busy = Array.from({ length: 120 }, (_, i) =>
      shopOrder(`2026-09-10T${String(i % 24).padStart(2, "0")}:00:00Z`, "10.00", [
        { quantity: 1, productId: P1 },
      ]),
    );
    const big = shopOrder(
      "2026-09-11T10:00:00Z",
      "200.00",
      Array.from({ length: 20 }, () => ({ quantity: 1, productId: P2 })),
    );
    const { fake, provider } = shopify({ orders: [...busy, big] });
    const all = (await runToDone(provider)).flatMap((p) => p.observations);

    expect(ordersOf(all)).toBe(121);
    expect(unitsOf(all, P1)).toBe(120);
    expect(unitsOf(all, P2)).toBe(20);
    expect(fake.calls.filter((c) => c.query === SHOPIFY_QUERIES.orders).length).toBeGreaterThan(2);
    expect(fake.calls.some((c) => c.query === SHOPIFY_QUERIES.order_line_items)).toBe(true);
  });

  it("a daily run re-reads the last 30 days, so a late refund is picked up", async () => {
    const { fake, provider } = shopify({ orders: [shopOrder("2026-09-01T10:00:00Z", "80.00")] });
    await runToDone(provider);

    const target = fake.orders[0];
    if (target) target.refunded = "30.00";

    const page = await provider.pull(FAKE_SHOPIFY_SECRET, "2026-09-12", NOW);
    expect(orderDays(page.observations)).toHaveLength(SHOPIFY_REREAD_DAYS);
    expect(page).toMatchObject({ cursor: "2026-09-13", done: true });
    expect(revenueOf(page.observations, "EUR")).toBe(5_000);
  });

  it("reuses the 24-hour token instead of exchanging on every call", async () => {
    const { fake, provider } = shopify();
    await provider.connect(FAKE_SHOPIFY_SECRET);
    await runToDone(provider);
    expect(fake.calls.filter((c) => c.url.pathname === "/admin/oauth/access_token")).toHaveLength(
      1,
    );
  });
});

describe("retries are capped", () => {
  const throttled = () =>
    shopifyJson(200, { errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }] });

  it("a throttled query is retried with backoff, then succeeds", async () => {
    const sleeps: number[] = [];
    const { provider } = shopify(
      { respond: (call, n) => (call.query && n === 2 ? throttled() : null) },
      sleeps,
    );
    await expect(provider.connect(FAKE_SHOPIFY_SECRET)).resolves.toBeDefined();
    expect(sleeps).toHaveLength(1);
  });

  it("persistent throttling fails after the attempt cap", async () => {
    const { fake, provider } = shopify({ respond: (call) => (call.query ? throttled() : null) });
    await expect(provider.connect(FAKE_SHOPIFY_SECRET)).rejects.toThrow(/still throttled/);
    expect(fake.calls.filter((c) => c.query !== null)).toHaveLength(SHOPIFY_MAX_ATTEMPTS);
  });

  it("an expired token is exchanged again once", async () => {
    let rejected = false;
    const { fake, provider } = shopify({
      respond: (call) => {
        if (call.query !== null && !rejected) {
          rejected = true;
          return shopifyJson(401, { errors: "expired" });
        }
        return null;
      },
    });
    await expect(provider.connect(FAKE_SHOPIFY_SECRET)).resolves.toBeDefined();
    expect(fake.calls.filter((c) => c.url.pathname === "/admin/oauth/access_token")).toHaveLength(
      2,
    );
  });
});

describe("P2-15 — listing products", () => {
  it("returns every product across pages, with the id observations carry", async () => {
    const products = Array.from({ length: 260 }, (_, i) => ({
      id: `gid://shopify/Product/${i + 1}`,
      title: `Product ${i + 1}`,
      status: "ACTIVE",
    }));
    const { provider } = shopify({ products });
    const listed = (await provider.listProducts?.(FAKE_SHOPIFY_SECRET)) ?? [];
    expect(listed).toHaveLength(260);
    expect(listed[0]).toEqual({
      ref: "gid://shopify/Product/1",
      title: "Product 1",
      status: "ACTIVE",
    });
  });
});
