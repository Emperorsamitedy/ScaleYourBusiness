// Idea 48 — order baskets from the store syncs, read-only.
//
// What must hold, against recorded-shape Shopify and WooCommerce with the
// global fetch stubbed to fail if anything real is touched:
//   · NO NEW SCOPE, NO NEW QUERY. Baskets come from the order lines the
//     sync already reads (read_orders): the registry is unchanged and the
//     scope audit stays green.
//   · THE SHAPE. One basket per counted order — the same orders revenue
//     counts — holding its distinct product ids; a custom line or a
//     refunded-away line isn't in it, and an order with nothing left in it
//     isn't a basket.
//   · THE WINDOW. A re-read replaces the baskets of the days it covers, so
//     an order cancelled since the last sync drops out and nothing is
//     counted twice.

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
  orderBaskets,
} from "../../db/schema";
import { bootstrapIntake } from "../intake/service";
import { basketOf } from "./baskets";
import type { ShopifyOrder } from "./providers/shopify";
import { SHOPIFY_QUERIES, basketsOfOrders, createShopifyProvider } from "./providers/shopify";
import { FAKE_SHOPIFY_SECRET, fakeShopify, shopOrder } from "./providers/shopify-fake";
import type { WooOrder } from "./providers/woocommerce";
import { WOO_READ_ENDPOINTS, basketsOfWooOrders } from "./providers/woocommerce";
import { overrideProviderForTests } from "./registry";
import { SCOPE_REGISTRY, auditRegistry } from "./scopes";
import { connect } from "./service";
import { syncConnection } from "./sync";

const NOW = new Date("2026-10-22T06:00:00Z");
const noSleep = async () => {};
const MUG = "gid://shopify/Product/1";
const BOWL = "gid://shopify/Product/2";

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

describe("no new permission", () => {
  it("the registry for both stores is the read-only one it was, and the audit passes", () => {
    expect(SCOPE_REGISTRY.shopify).toEqual(["read_orders", "read_products", "read_all_orders"]);
    expect(SCOPE_REGISTRY.woocommerce).toEqual(["read_orders", "read_products"]);
    expect(auditRegistry()).toEqual([]);
    expect(Object.keys(WOO_READ_ENDPOINTS).sort()).toEqual(["read_orders", "read_products"]);
    // The product id was already read on every order line.
    expect(SHOPIFY_QUERIES.orders).toMatch(/product \{\s*id\s*\}/);
  });
});

describe("a basket", () => {
  it("is the order's distinct products, sorted", () => {
    expect(
      basketOf("o1", "2026-10-20", [
        { productRef: "b", quantity: 1 },
        { productRef: "a", quantity: 2 },
        { productRef: "b", quantity: 1 },
      ]),
    ).toEqual({ order_ref: "o1", day: "2026-10-20", product_refs: ["a", "b"] });
  });

  it("leaves out custom and refunded-away lines, and isn't one with nothing left", () => {
    expect(
      basketOf("o2", "2026-10-20", [
        { productRef: null, quantity: 1 },
        { productRef: "a", quantity: 0 },
        { productRef: "b", quantity: 1 },
      ])?.product_refs,
    ).toEqual(["b"]);
    expect(basketOf("o3", "2026-10-20", [{ productRef: null, quantity: 1 }])).toBeNull();
  });
});

describe("the stores' baskets count the orders revenue counts", () => {
  const start = new Date("2026-10-19T00:00:00Z");
  const end = new Date("2026-10-20T00:00:00Z");

  it("Shopify: no test or cancelled order, and the UTC day", () => {
    const order = (id: string, extra: Partial<ShopifyOrder> = {}): ShopifyOrder => ({
      id,
      createdAt: "2026-10-19T23:30:00Z",
      cancelledAt: null,
      test: false,
      total: "10.00",
      refunded: "0.00",
      currency: "EUR",
      lines: [
        { productRef: MUG, quantity: 1 },
        { productRef: BOWL, quantity: 1 },
      ],
      ...extra,
    });
    const w = basketsOfOrders(
      [
        order("kept"),
        order("test", { test: true }),
        order("cancelled", { cancelledAt: "2026-10-20T08:00:00Z" }),
        order("outside", { createdAt: "2026-10-21T00:00:00Z" }),
      ],
      start,
      end,
    );
    expect(w.from).toBe("2026-10-19");
    expect(w.to).toBe("2026-10-20");
    expect(w.orders).toEqual([{ order_ref: "kept", day: "2026-10-19", product_refs: [MUG, BOWL] }]);
  });

  it("WooCommerce: the counted statuses only, product ids as strings", () => {
    const order = (id: number, status: string): WooOrder => ({
      id,
      status,
      currency: "EUR",
      total: "10.00",
      dateCreatedGmt: "2026-10-20T10:00:00",
      refunds: [],
      lines: [
        { productId: 11, quantity: 1 },
        { productId: 12, quantity: 2 },
        { productId: 0, quantity: 1 },
      ],
    });
    const w = basketsOfWooOrders(
      [order(1, "completed"), order(2, "pending"), order(3, "cancelled"), order(4, "processing")],
      start,
      end,
    );
    expect(w.orders.map((o) => [o.order_ref, o.product_refs])).toEqual([
      ["1", ["11", "12"]],
      ["4", ["11", "12"]],
    ]);
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
    // order_baskets go with their connection (on delete cascade).
    await db.delete(connections).where(inArray(connections.account_id, accountIds));
  }
  await db.delete(intakeEvents).where(inArray(intakeEvents.profile_id, ids));
  await db.delete(fieldRecords).where(inArray(fieldRecords.profile_id, ids));
  await db.delete(businessProfiles).where(inArray(businessProfiles.id, ids));
  await db.delete(accounts).where(inArray(accounts.id, accountIds));
});

describe("the sync stores baskets with each page", () => {
  it("stores one per counted order, and a re-read replaces its days", async () => {
    const together = shopOrder("2026-10-20T10:00:00Z", "123.00", [
      { quantity: 1, productId: MUG },
      { quantity: 1, productId: BOWL },
    ]);
    const alone = shopOrder("2026-10-21T10:00:00Z", "34.00", [{ quantity: 1, productId: MUG }]);
    const custom = shopOrder("2026-10-21T11:00:00Z", "5.00", [{ quantity: 1, productId: null }]);
    const fake = fakeShopify({ now: NOW, orders: [together, alone, custom] });
    restores.push(
      overrideProviderForTests(
        "shopify",
        createShopifyProvider({ fetch: fake.fetch, sleep: noSleep }),
      ),
    );
    const s = await bootstrapIntake();
    created.push(s);
    const conn = await connect(s.account_id, "shopify", FAKE_SHOPIFY_SECRET);
    expect((await syncConnection(conn.id, NOW)).ok).toBe(true);

    const read = async () =>
      (await db.select().from(orderBaskets).where(eq(orderBaskets.connection_id, conn.id)))
        .map((r) => [r.order_ref, r.day, r.product_refs])
        .sort();
    expect(await read()).toEqual(
      [
        [together.id, "2026-10-20", [MUG, BOWL]],
        [alone.id, "2026-10-21", [MUG]],
      ].sort(),
    );

    // The together order is cancelled; the next sync re-reads its day and drops it.
    fake.orders[0]!.cancelledAt = "2026-10-22T09:00:00Z";
    const later = new Date("2026-10-23T06:00:00Z");
    expect((await syncConnection(conn.id, later)).ok).toBe(true);
    expect(await read()).toEqual([[alone.id, "2026-10-21", [MUG]]]);
  });
});
