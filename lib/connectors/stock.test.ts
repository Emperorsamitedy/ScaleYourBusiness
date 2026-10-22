// Feature 34 — stock levels from the stores, read-only.
//
// What must hold, against recorded-shape Shopify and WooCommerce with the
// global fetch stubbed to fail if anything real is touched:
//   · NO NEW SCOPE. Stock rides on read_products, which both connectors
//     already hold (Shopify's docs, read 2026-10-22: ProductVariant and
//     InventoryItem are readable under read_products). The registry for both
//     is unchanged, and the scope audit stays green.
//   · THE SHAPES. A snapshot per product: tracked variants' quantity summed,
//     valued at price and at unit cost; an untracked product counted, a
//     missing cost making cash tied up unknown, never partial.
//   · THE SYNC. The runner takes the snapshot after the pages; it never
//     moves the latest daily figure (derive windows still end yesterday),
//     and a failing snapshot doesn't fail the sync.

import "dotenv/config";
process.env.CONNECTOR_KEY ??= "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../../db";
import {
  accounts,
  businessProfiles,
  connections,
  connectorSyncs,
  fieldRecords,
  intakeEvents,
  metricObservations,
} from "../../db/schema";
import { bootstrapIntake } from "../intake/service";
import { latestObservedDate } from "./derive";
import { STOCK_METRICS } from "./provider";
import { createShopifyProvider, aggregateStock, SHOPIFY_QUERIES } from "./providers/shopify";
import { FAKE_SHOPIFY_SECRET, fakeShopify, shopOrder } from "./providers/shopify-fake";
import { createWooCommerceProvider } from "./providers/woocommerce";
import { FAKE_WOO_SECRET, fakeWoo } from "./providers/woocommerce-fake";
import { overrideProviderForTests } from "./registry";
import { SCOPE_REGISTRY, auditRegistry } from "./scopes";
import { connect } from "./service";
import { syncConnection } from "./sync";

const NOW = new Date("2026-10-22T06:00:00Z");
const noSleep = async () => {};

let realFetchUsed = false;
beforeEach(() => {
  realFetchUsed = false;
  vi.stubGlobal("fetch", async () => {
    realFetchUsed = true;
    throw new Error("no real network in tests");
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  expect(realFetchUsed).toBe(false);
});

const PRODUCTS = [
  {
    id: "gid://shopify/Product/1",
    title: "Large Serving Bowl",
    status: "ACTIVE",
    variants: [
      { quantity: 30, price: "89.00", cost: "26.00" },
      { quantity: 10, price: "89.00", cost: "26.00" },
    ],
  },
  {
    id: "gid://shopify/Product/2",
    title: "Gift Card",
    status: "ACTIVE",
    variants: [{ quantity: null, price: "25.00", cost: null, tracked: false }],
  },
  {
    id: "gid://shopify/Product/3",
    title: "Glaze Test Tile",
    status: "ACTIVE",
    variants: [
      { quantity: 12, price: "6.00", cost: "1.50" },
      { quantity: 3, price: "6.00", cost: null },
    ],
  },
  {
    id: "gid://shopify/Product/4",
    title: "Oversold Mug",
    status: "ACTIVE",
    variants: [{ quantity: -2, price: "34.00", cost: "9.80" }],
  },
];

describe("no new scope: stock rides on read_products", () => {
  it("the registry for both stores is unchanged, and the audit is green", () => {
    expect(SCOPE_REGISTRY.shopify).toEqual(["read_orders", "read_products", "read_all_orders"]);
    expect(SCOPE_REGISTRY.woocommerce).toEqual(["read_orders", "read_products"]);
    expect(auditRegistry()).toEqual([]);
  });

  it("the Shopify stock document is a registered read query", () => {
    expect(SHOPIFY_QUERIES.stock.startsWith("query Stock")).toBe(true);
    expect(SHOPIFY_QUERIES.stock).not.toMatch(/mutation/i);
  });
});

describe("Shopify — the stock snapshot", () => {
  it("sums tracked variants, values them at price and cost, and counts what it can't read", async () => {
    const fake = fakeShopify({ products: PRODUCTS, now: NOW });
    const provider = createShopifyProvider({ fetch: fake.fetch, sleep: noSleep });
    const read = await provider.readStock!(FAKE_SHOPIFY_SECRET, NOW, { currency: null });

    expect(read.untracked).toBe(1); // the gift card
    expect(read.cost_unknown).toBe(1); // the tile: one stocked variant without a cost
    const of = (ref: string) =>
      Object.fromEntries(
        read.observations
          .filter((o) => o.dimensions.product_ref === ref)
          .map((o) => [o.metric_key, o.value_num ?? o.value_minor]),
      );
    expect(of("gid://shopify/Product/1")).toEqual({
      "stock.on_hand": 40,
      "stock.value_at_price": 40 * 8_900,
      "stock.value_at_cost": 40 * 2_600,
    });
    expect(of("gid://shopify/Product/3")).toEqual({
      "stock.on_hand": 15,
      "stock.value_at_price": 15 * 600,
    });
    // Oversold: none on hand, never a negative.
    expect(of("gid://shopify/Product/4")["stock.on_hand"]).toBe(0);
    for (const o of read.observations) {
      expect(o.period_date).toBe("2026-10-22");
      expect(STOCK_METRICS.has(o.metric_key)).toBe(true);
    }
    expect(read.observations[0]!.dimensions.item_name).toBe("Large Serving Bowl");
    // Every call was the registered stock query (after the token exchange).
    for (const c of fake.calls.filter((c) => c.query !== null)) {
      expect(c.query).toBe(SHOPIFY_QUERIES.stock);
    }
  });

  it("pages through products", async () => {
    const many = Array.from({ length: 23 }, (_, i) => ({
      id: `gid://shopify/Product/${i + 1}`,
      title: `P${i + 1}`,
      status: "ACTIVE",
      variants: [{ quantity: 1, price: "1.00", cost: "0.50" }],
    }));
    const fake = fakeShopify({ products: many });
    const provider = createShopifyProvider({ fetch: fake.fetch, sleep: noSleep });
    const read = await provider.readStock!(FAKE_SHOPIFY_SECRET, NOW, { currency: null });
    expect(read.observations.filter((o) => o.metric_key === "stock.on_hand")).toHaveLength(23);
    expect(fake.calls.filter((c) => c.query === SHOPIFY_QUERIES.stock)).toHaveLength(3);
  });

  it("a variant cost in another currency than the shop's is unknown, never converted", () => {
    const read = aggregateStock(
      [
        {
          id: "p",
          title: "Mug",
          truncated: false,
          variants: [
            {
              quantity: 2,
              price: "10.00",
              tracked: true,
              unitCost: { amount: "3.00", currencyCode: "USD" },
            },
          ],
        },
      ],
      "EUR",
      "2026-10-22",
      NOW.toISOString(),
    );
    expect(read.cost_unknown).toBe(1);
    expect(read.observations.map((o) => o.metric_key)).toEqual([
      "stock.on_hand",
      "stock.value_at_price",
    ]);
  });
});

describe("WooCommerce — the stock snapshot", () => {
  it("reads managed stock from the product list it already reads; no cost in core", async () => {
    const fake = fakeWoo({
      products: [
        {
          id: 11,
          name: "Candle",
          status: "publish",
          manage_stock: true,
          stock_quantity: 25,
          price: "18.50",
        },
        {
          id: 12,
          name: "Gift wrap",
          status: "publish",
          manage_stock: false,
          stock_quantity: null,
          price: "2.00",
        },
        { id: 13, name: "Variable tee", status: "publish", manage_stock: false, price: "" },
      ],
    });
    const provider = createWooCommerceProvider({ fetch: fake.fetch, sleep: noSleep });
    const read = await provider.readStock!(FAKE_WOO_SECRET, NOW, { currency: "EUR" });
    expect(read.untracked).toBe(2);
    expect(read.cost_unknown).toBe(1);
    expect(read.observations.map((o) => [o.metric_key, o.value_num ?? o.value_minor])).toEqual([
      ["stock.on_hand", 25],
      ["stock.value_at_price", 25 * 1_850],
    ]);
    for (const c of fake.calls) {
      expect(c.init.method).toBe("GET");
      expect(c.url.pathname).toBe("/wp-json/wc/v3/products");
    }
  });

  it("without the store's currency, prices are left unvalued rather than guessed", async () => {
    const fake = fakeWoo({
      products: [
        {
          id: 11,
          name: "Candle",
          status: "publish",
          manage_stock: true,
          stock_quantity: 5,
          price: "18.50",
        },
      ],
    });
    const provider = createWooCommerceProvider({ fetch: fake.fetch, sleep: noSleep });
    const read = await provider.readStock!(FAKE_WOO_SECRET, NOW, { currency: null });
    expect(read.observations.map((o) => o.metric_key)).toEqual(["stock.on_hand"]);
  });
});

/* ── through the sync runner ── */

const created: { account_id: string; profile_id: string }[] = [];
const restores: (() => void)[] = [];

afterAll(async () => {
  for (const r of restores) r();
  const accountIds = created.map((s) => s.account_id);
  const ids = created.map((s) => s.profile_id);
  if (accountIds.length === 0) return;
  const conns = await db
    .select({ id: connections.id })
    .from(connections)
    .where(inArray(connections.account_id, accountIds));
  const connIds = conns.map((c) => c.id);
  if (connIds.length > 0) {
    await db.delete(metricObservations).where(inArray(metricObservations.connection_id, connIds));
    await db.delete(connectorSyncs).where(inArray(connectorSyncs.connection_id, connIds));
    await db.delete(connections).where(inArray(connections.account_id, accountIds));
  }
  await db.delete(intakeEvents).where(inArray(intakeEvents.profile_id, ids));
  await db.delete(fieldRecords).where(inArray(fieldRecords.profile_id, ids));
  await db.delete(businessProfiles).where(inArray(businessProfiles.id, ids));
  await db.delete(accounts).where(inArray(accounts.id, accountIds));
});

describe("the sync takes the snapshot", () => {
  it("stores it after the pages, and the latest daily figure still ends yesterday", async () => {
    const fake = fakeShopify({
      products: PRODUCTS,
      now: NOW,
      orders: [
        shopOrder("2026-10-20T10:00:00Z", "89.00", [{ quantity: 1, productId: PRODUCTS[0]!.id }]),
      ],
    });
    restores.push(
      overrideProviderForTests(
        "shopify",
        createShopifyProvider({ fetch: fake.fetch, sleep: noSleep }),
      ),
    );
    const s = await bootstrapIntake();
    created.push(s);
    const conn = await connect(s.account_id, "shopify", FAKE_SHOPIFY_SECRET);
    const outcome = await syncConnection(conn.id, NOW);
    expect(outcome.ok).toBe(true);
    // Bowl and mug: on hand, at price, at cost (3 each); the tile: no cost (2).
    expect(outcome.stock).toEqual({ observations: 8, untracked: 1, cost_unknown: 1 });

    const stock = await db
      .select()
      .from(metricObservations)
      .where(eq(metricObservations.connection_id, conn.id));
    const onHand = stock.filter((r) => r.metric_key === "stock.on_hand");
    expect(onHand).toHaveLength(3);
    expect(onHand[0]!.period_date).toBe("2026-10-22");
    expect(await latestObservedDate(conn.id)).toBe("2026-10-21");
  });

  it("a failing snapshot leaves the sync a success", async () => {
    const fake = fakeShopify({
      now: NOW,
      respond: (call) =>
        call.query?.startsWith("query Stock")
          ? { status: 200, json: async () => ({ errors: [{ message: "boom" }] }) }
          : null,
    });
    restores.push(
      overrideProviderForTests(
        "shopify",
        createShopifyProvider({ fetch: fake.fetch, sleep: noSleep }),
      ),
    );
    const s = await bootstrapIntake();
    created.push(s);
    const conn = await connect(s.account_id, "shopify", FAKE_SHOPIFY_SECRET);
    const outcome = await syncConnection(conn.id, NOW);
    expect(outcome.ok).toBe(true);
    expect(outcome.stock).toBeNull();
  });
});
