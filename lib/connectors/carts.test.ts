// Idea 47 — abandoned carts from Shopify, read-only.
//
// What must hold, against a recorded-shape Shopify with the global fetch
// stubbed to fail if anything real is touched:
//   · ONE OPTIONAL SCOPE. abandonedCheckouts rides on read_orders, which
//     the connector already holds (Shopify's docs, read 2026-10-29). The
//     shopper needs read_customers, optional and read-only (I-47b,
//     2026-10-30); the scope audit stays green.
//   · THE SHOPPER ONLY WITH IT. Without read_customers the plain document
//     never asks for the customer, and every cart lands with a null hash.
//     With it the shoppers document asks for the customer's email and
//     marketing tick and nothing else; if Shopify still withholds customer
//     data, the plain document is read instead and the read says "refused".
//   · THE SHAPE. Totals and line prices in minor units, the cart's own
//     currency, products by Shopify id, a later finish kept, extra lines
//     counted as truncated rather than read short, pages followed.
//   · THE STORE. Upsert per cart, 90 days kept; an email any store gives
//     becomes the keyed hash and is dropped, an erased one isn't linked
//     again, and erasing a contact deletes their carts.
//   · THE SYNC. The read runs after the pages and the stock; a failing read
//     doesn't fail the sync.

import "dotenv/config";
process.env.CONNECTOR_KEY ??= "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../../db";
import {
  abandonedCheckouts,
  accounts,
  businessProfiles,
  connections,
  connectorSyncs,
  contactSuppressions,
  contacts,
  fieldRecords,
  intakeEvents,
  metricObservations,
} from "../../db/schema";
import { pruneExpiredCarts, retentionCutoff, storeCarts } from "../carts/store";
import { addContact, emailHash, eraseContact } from "../crm/contacts";
import { bootstrapIntake } from "../intake/service";
import type { ExternalCart } from "./provider";
import { ProviderError } from "./provider";
import {
  SHOPIFY_CART_LINES,
  SHOPIFY_QUERIES,
  createShopifyProvider,
  parseCart,
} from "./providers/shopify";
import { FAKE_SHOPIFY_SECRET, fakeShopify, shopCart, shopifyJson } from "./providers/shopify-fake";
import { overrideProviderForTests } from "./registry";
import { SCOPE_REGISTRY, auditRegistry } from "./scopes";
import { connect, disconnect } from "./service";
import { syncConnection } from "./sync";

const NOW = new Date("2026-10-29T06:00:00Z");
const noSleep = async () => {};
const MUG = "gid://shopify/Product/1";
const BOWL = "gid://shopify/Product/2";
const daysAgo = (n: number, hhmm = "10:00") =>
  `${new Date(NOW.getTime() - n * 86_400_000).toISOString().slice(0, 10)}T${hhmm}:00Z`;

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

describe("carts ride on read_orders; the shopper on optional read_customers", () => {
  it("the registry gains only read_customers, and the audit is green", () => {
    expect(SCOPE_REGISTRY.shopify).toEqual([
      "read_orders",
      "read_products",
      "read_all_orders",
      "read_customers",
    ]);
    expect(auditRegistry()).toEqual([]);
  });

  it("the shoppers document adds the customer's email and tick, and nothing else of them", () => {
    const doc = SHOPIFY_QUERIES.abandoned_checkouts_shoppers;
    expect(doc.startsWith("query AbandonedCheckoutsShoppers")).toBe(true);
    expect(doc).not.toMatch(/mutation/i);
    const customer = /customer \{([\s\S]*?)\n {6}\}/.exec(doc)?.[1] ?? "";
    expect(customer.replace(/\s+/g, " ").trim()).toBe(
      "defaultEmailAddress { emailAddress marketingState }",
    );
    expect(doc).not.toMatch(/phone|billingAddress|shippingAddress|firstName|lastName|displayName/i);
    // Otherwise the very same read as the plain document.
    expect(
      doc
        .replace("AbandonedCheckoutsShoppers", "AbandonedCheckouts")
        .replace(/\n {6}customer \{[\s\S]*?\n {6}\}/, ""),
    ).toBe(SHOPIFY_QUERIES.abandoned_checkouts);
  });

  it("the document is a registered read query that never asks for the shopper", () => {
    const doc = SHOPIFY_QUERIES.abandoned_checkouts;
    expect(doc.startsWith("query AbandonedCheckouts")).toBe(true);
    expect(doc).not.toMatch(/mutation/i);
    expect(doc).not.toMatch(/customer|email|address|phone|name\b/i);
  });

  it("the fake refuses a document that asks for the customer without read_customers, as Shopify does", async () => {
    const fake = fakeShopify({ now: NOW, carts: [shopCart(daysAgo(2), "10.00")] });
    const token = await fake.fetch("https://ember-oak.myshopify.com/admin/oauth/access_token", {
      method: "POST",
      headers: {},
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: "fake-client-id",
        client_secret: "shpss_fakeClientSecretForTests",
      }).toString(),
    });
    const { access_token } = (await token.json()) as { access_token: string };
    const res = await fake.fetch("https://ember-oak.myshopify.com/admin/api/2026-07/graphql.json", {
      method: "POST",
      headers: { "x-shopify-access-token": access_token },
      body: JSON.stringify({
        query:
          "query AbandonedCheckouts { abandonedCheckouts(first: 1) { nodes { customer { email } } } }",
        variables: {},
      }),
    });
    const body = (await res.json()) as { errors?: { message: string }[] };
    expect(body.errors?.[0]?.message).toMatch(/read_customers/);
  });
});

describe("Shopify — the shopper, with and without read_customers (I-47b)", () => {
  const WITH = ["read_orders", "read_products", "read_customers"];
  const carts = () => [
    shopCart(daysAgo(2), "30.00", undefined, {
      email: "Yes@Example.com",
      marketingState: "SUBSCRIBED",
    }),
    shopCart(daysAgo(3), "20.00", undefined, {
      email: "no@example.com",
      marketingState: "UNSUBSCRIBED",
    }),
    shopCart(daysAgo(4), "10.00"), // a draft order: no customer
  ];

  it("with read_customers, each cart carries its shopper's email and Shopify's tick", async () => {
    const fake = fakeShopify({ now: NOW, scopes: WITH, carts: carts() });
    const provider = createShopifyProvider({ fetch: fake.fetch, sleep: noSleep });
    const read = await provider.readAbandonedCheckouts!(FAKE_SHOPIFY_SECRET, NOW, 60);
    expect(read.shopper).toBe("read");
    const by = (total: number) => read.carts.find((c) => c.total_minor === total)!;
    expect(by(3_000)).toMatchObject({ email: "Yes@Example.com", accepts_marketing: true });
    expect(by(2_000)).toMatchObject({ email: "no@example.com", accepts_marketing: false });
    expect(by(1_000)).toMatchObject({ email: null, accepts_marketing: null });
    for (const c of fake.calls.filter((c) => c.query !== null && c.query.includes("Abandoned"))) {
      expect(c.query).toBe(SHOPIFY_QUERIES.abandoned_checkouts_shoppers);
    }
  });

  it("without it, the plain document is sent and the read says not granted", async () => {
    const fake = fakeShopify({ now: NOW, carts: carts() });
    const provider = createShopifyProvider({ fetch: fake.fetch, sleep: noSleep });
    const read = await provider.readAbandonedCheckouts!(FAKE_SHOPIFY_SECRET, NOW, 60);
    expect(read.shopper).toBe("not_granted");
    expect(read.carts.every((c) => c.email === null && c.accepts_marketing === null)).toBe(true);
    for (const c of fake.calls.filter((c) => c.query !== null && c.query.includes("Abandoned"))) {
      expect(c.query).toBe(SHOPIFY_QUERIES.abandoned_checkouts);
    }
  });

  it("when Shopify withholds customer data anyway, carts are still read, without shoppers", async () => {
    const fake = fakeShopify({
      now: NOW,
      scopes: WITH,
      customerDataWithheld: true,
      carts: carts(),
    });
    const provider = createShopifyProvider({ fetch: fake.fetch, sleep: noSleep });
    const read = await provider.readAbandonedCheckouts!(FAKE_SHOPIFY_SECRET, NOW, 60);
    expect(read.shopper).toBe("refused");
    expect(read.carts).toHaveLength(3);
    expect(read.carts.every((c) => c.email === null)).toBe(true);
    const sent = fake.calls.filter((c) => c.query?.includes("Abandoned")).map((c) => c.query);
    expect(sent).toEqual([
      SHOPIFY_QUERIES.abandoned_checkouts_shoppers,
      SHOPIFY_QUERIES.abandoned_checkouts,
    ]);
  });

  it("an unknown marketing state is not read as either answer", () => {
    const node = {
      id: "gid://shopify/AbandonedCheckout/7",
      createdAt: daysAgo(1),
      updatedAt: daysAgo(1),
      completedAt: null,
      totalPriceSet: { shopMoney: { amount: "10.00", currencyCode: "EUR" } },
      lineItems: { nodes: [], pageInfo: { hasNextPage: false } },
      customer: { defaultEmailAddress: { emailAddress: "a@example.com", marketingState: "NEW" } },
    };
    expect(parseCart(node, true)).toMatchObject({
      email: "a@example.com",
      accepts_marketing: null,
    });
    // The plain document's parse never takes a shopper, even one in the response.
    expect(parseCart(node)).toMatchObject({ email: null, accepts_marketing: null });
  });

  it("another error on the shoppers document is not taken for a refusal", async () => {
    const fake = fakeShopify({
      now: NOW,
      scopes: WITH,
      carts: carts(),
      respond: (call) =>
        call.query?.startsWith("query AbandonedCheckoutsShoppers")
          ? shopifyJson(200, { errors: [{ message: "Internal error" }] })
          : null,
    });
    const provider = createShopifyProvider({ fetch: fake.fetch, sleep: noSleep });
    await expect(provider.readAbandonedCheckouts!(FAKE_SHOPIFY_SECRET, NOW, 60)).rejects.toThrow(
      /Internal error/,
    );
  });
});

describe("Shopify — reading the carts", () => {
  it("reads totals, lines and a later finish in minor units; no shopper on any cart", async () => {
    const fake = fakeShopify({
      now: NOW,
      carts: [
        shopCart(
          daysAgo(3),
          "112.50",
          [
            { title: "Speckled Mug", quantity: 2, price: "34.00", productId: MUG },
            { title: "Gift note", quantity: 1, price: "2.50", productId: null },
          ],
          { email: "shopper@example.com" },
        ),
        shopCart(
          daysAgo(5),
          "89.00",
          [{ title: "Bowl", quantity: 1, price: "89.00", productId: BOWL }],
          {
            completedAt: daysAgo(4),
          },
        ),
        shopCart(daysAgo(70), "40.00"), // older than the read window
      ],
    });
    const provider = createShopifyProvider({ fetch: fake.fetch, sleep: noSleep });
    const read = await provider.readAbandonedCheckouts!(FAKE_SHOPIFY_SECRET, NOW, 60);
    expect(read.carts).toHaveLength(2);
    const left = read.carts.find((c) => c.completed_at === null)!;
    const recovered = read.carts.find((c) => c.completed_at !== null)!;
    expect(left.total_minor).toBe(11_250);
    expect(left.currency).toBe("EUR");
    expect(left.completed_at).toBeNull();
    expect(left.lines).toEqual([
      { product_ref: MUG, title: "Speckled Mug", quantity: 2, unit_price_minor: 3_400 },
      { product_ref: null, title: "Gift note", quantity: 1, unit_price_minor: 250 },
    ]);
    expect(left.email).toBeNull(); // Shopify holds it; the document never asks
    expect(left.accepts_marketing).toBeNull();
    expect(recovered.completed_at).toBe(daysAgo(4));
    for (const c of fake.calls.filter((c) => c.query !== null)) {
      expect(c.query).toBe(SHOPIFY_QUERIES.abandoned_checkouts);
    }
  });

  it("follows pages, and marks a cart with more lines than one read takes", async () => {
    const many = Array.from({ length: 120 }, (_, i) => shopCart(daysAgo(1 + (i % 50)), "5.00"));
    const long = shopCart(
      daysAgo(2),
      "80.00",
      Array.from({ length: SHOPIFY_CART_LINES + 2 }, () => ({
        title: "Tile",
        quantity: 1,
        price: "5.00",
        productId: MUG,
      })),
    );
    const fake = fakeShopify({ now: NOW, carts: [...many, long] });
    const provider = createShopifyProvider({ fetch: fake.fetch, sleep: noSleep });
    const read = await provider.readAbandonedCheckouts!(FAKE_SHOPIFY_SECRET, NOW, 60);
    expect(read.carts).toHaveLength(121);
    const got = read.carts.find((c) => c.ref === long.id)!;
    expect(got.lines).toHaveLength(SHOPIFY_CART_LINES);
    expect(got.lines_truncated).toBe(true);
    expect(fake.calls.filter((c) => c.query !== null).length).toBe(3);
  });

  it("an amount more precise than the currency is an error naming the cart, not a rounding", () => {
    const node = {
      id: "gid://shopify/AbandonedCheckout/9",
      createdAt: daysAgo(1),
      updatedAt: daysAgo(1),
      completedAt: null,
      totalPriceSet: { shopMoney: { amount: "10.005", currencyCode: "EUR" } },
      lineItems: { nodes: [], pageInfo: { hasNextPage: false } },
    };
    expect(() => parseCart(node)).toThrow(ProviderError);
    expect(() => parseCart(node)).toThrow(/AbandonedCheckout\/9/);
    expect(
      parseCart({ ...node, totalPriceSet: { shopMoney: { amount: "10.00", currencyCode: "EUR" } } })
        .total_minor,
    ).toBe(1_000);
  });

  it("a checkout missing a field is refused, not guessed", () => {
    expect(() => parseCart({ id: "x", createdAt: daysAgo(1) })).toThrow(/missing a field/);
  });
});

/* ── stored, and through the sync runner ── */

const created: { account_id: string; profile_id: string }[] = [];
const restores: (() => void)[] = [];

afterAll(async () => {
  for (const r of restores) r();
  const accountIds = created.map((s) => s.account_id);
  const ids = created.map((s) => s.profile_id);
  if (accountIds.length === 0) return;
  await db.delete(abandonedCheckouts).where(inArray(abandonedCheckouts.account_id, accountIds));
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
  await db.delete(contacts).where(inArray(contacts.account_id, accountIds));
  await db.delete(contactSuppressions).where(inArray(contactSuppressions.account_id, accountIds));
  await db.delete(intakeEvents).where(inArray(intakeEvents.profile_id, ids));
  await db.delete(fieldRecords).where(inArray(fieldRecords.profile_id, ids));
  await db.delete(businessProfiles).where(inArray(businessProfiles.id, ids));
  await db.delete(accounts).where(inArray(accounts.id, accountIds));
});

async function shopWith(options: Parameters<typeof fakeShopify>[0]) {
  const fake = fakeShopify({ now: NOW, ...options });
  restores.push(
    overrideProviderForTests(
      "shopify",
      createShopifyProvider({ fetch: fake.fetch, sleep: noSleep }),
    ),
  );
  const s = await bootstrapIntake();
  created.push(s);
  const conn = await connect(s.account_id, "shopify", FAKE_SHOPIFY_SECRET);
  return { s, conn, fake };
}

const cart = (over: Partial<ExternalCart>): ExternalCart => ({
  ref: `gid://shopify/AbandonedCheckout/${crypto.randomUUID()}`,
  started_at: daysAgo(2),
  updated_at: daysAgo(2),
  completed_at: null,
  total_minor: 5_000,
  currency: "EUR",
  lines: [],
  lines_truncated: false,
  email: null,
  accepts_marketing: null,
  ...over,
});

const stored = (connectionId: string) =>
  db.select().from(abandonedCheckouts).where(eq(abandonedCheckouts.connection_id, connectionId));

describe("the sync reads the carts", () => {
  it("stores them after the pages, and a re-read records a later finish once", async () => {
    const left = shopCart(daysAgo(3), "34.00", [
      { title: "Speckled Mug", quantity: 1, price: "34.00", productId: MUG },
    ]);
    const { conn, fake } = await shopWith({ carts: [left] });
    const first = await syncConnection(conn.id, NOW);
    expect(first.ok).toBe(true);
    expect(first.carts).toEqual({ stored: 1, hashed: 0, pruned: 0 });
    let rows = await stored(conn.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.day).toBe(daysAgo(3).slice(0, 10));
    expect(rows[0]!.total_minor).toBe(3_400);
    expect(rows[0]!.email_hash).toBeNull();
    expect(rows[0]!.completed_at).toBeNull();

    left.completedAt = daysAgo(1);
    left.updatedAt = daysAgo(1);
    const again = await syncConnection(conn.id, NOW);
    expect(again.carts?.stored).toBe(1);
    rows = await stored(conn.id);
    expect(rows).toHaveLength(1);
    expect(new Date(rows[0]!.completed_at!).toISOString()).toBe(new Date(daysAgo(1)).toISOString());
    expect(fake.calls.some((c) => c.query === SHOPIFY_QUERIES.abandoned_checkouts)).toBe(true);
  });

  it("a failing read leaves the sync a success", async () => {
    const { conn } = await shopWith({
      respond: (call) =>
        call.query?.startsWith("query AbandonedCheckouts")
          ? { status: 200, json: async () => ({ errors: [{ message: "boom" }] }) }
          : null,
    });
    const outcome = await syncConnection(conn.id, NOW);
    expect(outcome.ok).toBe(true);
    expect(outcome.carts).toBeNull();
  });
});

// Review 2026-10-30: how the reads went, for the carts screen.
describe("the connection records its cart reads", () => {
  const state = async (id: string) =>
    (await db.select().from(connections).where(eq(connections.id, id)))[0]!.cart_read;

  it("a good read records when; a later failure keeps it and says too many", async () => {
    let endless = false;
    const { conn } = await shopWith({
      carts: [shopCart(daysAgo(2), "10.00")],
      respond: (call) =>
        endless && call.query?.startsWith("query AbandonedCheckouts")
          ? {
              status: 200,
              json: async () => ({
                data: {
                  abandonedCheckouts: {
                    nodes: [],
                    pageInfo: { hasNextPage: true, endCursor: "more" },
                  },
                },
              }),
            }
          : null,
    });
    await syncConnection(conn.id, NOW);
    expect(await state(conn.id)).toEqual({
      ok_at: NOW.toISOString(),
      failed_at: null,
      too_many: false,
      shopper: "not_granted",
    });
    endless = true;
    const later = new Date(NOW.getTime() + 86_400_000);
    expect((await syncConnection(conn.id, later)).ok).toBe(true);
    expect(await state(conn.id)).toEqual({
      ok_at: NOW.toISOString(),
      failed_at: later.toISOString(),
      too_many: true,
      shopper: "not_granted",
    });
  });

  it("with read_customers, the sync hashes each shopper and records that it read them", async () => {
    const { s, conn } = await shopWith({
      scopes: ["read_orders", "read_products", "read_customers"],
      carts: [
        shopCart(daysAgo(2), "10.00", [], {
          email: "Keen@Example.com",
          marketingState: "SUBSCRIBED",
        }),
        shopCart(daysAgo(3), "12.00"),
      ],
    });
    const outcome = await syncConnection(conn.id, NOW);
    expect(outcome.carts).toMatchObject({ stored: 2, hashed: 1 });
    expect((await state(conn.id))?.shopper).toBe("read");
    const rows = await stored(conn.id);
    expect(JSON.stringify(rows)).not.toMatch(/example\.com/i);
    const keen = rows.find((r) => r.email_hash !== null)!;
    expect(keen.email_hash).toBe(emailHash("keen@example.com"));
    // Shopify's tick is kept as a flag, never as consent (I-47a): no contact appears.
    expect(keen.accepts_marketing).toBe(true);
    const made = await db.select().from(contacts).where(eq(contacts.account_id, s.account_id));
    expect(made).toHaveLength(0);
  });

  it("when Shopify withholds customer data, the read says refused and still stores the carts", async () => {
    const { conn } = await shopWith({
      scopes: ["read_orders", "read_products", "read_customers"],
      customerDataWithheld: true,
      carts: [shopCart(daysAgo(2), "10.00", [], { email: "keen@example.com" })],
    });
    const outcome = await syncConnection(conn.id, NOW);
    expect(outcome.carts).toMatchObject({ stored: 1, hashed: 0 });
    expect((await state(conn.id))?.shopper).toBe("refused");
  });

  it("an ordinary failure isn't too many", async () => {
    const { conn } = await shopWith({
      respond: (call) =>
        call.query?.startsWith("query AbandonedCheckouts")
          ? { status: 200, json: async () => ({ errors: [{ message: "boom" }] }) }
          : null,
    });
    await syncConnection(conn.id, NOW);
    expect(await state(conn.id)).toMatchObject({ ok_at: null, too_many: false });
  });
});

describe("the store keeps no address, and forgets on time", () => {
  it("prunes carts past 90 days and keeps the one at 89", async () => {
    const { s, conn } = await shopWith({});
    // Stored five days ago, when both were under 90 days old.
    await storeCarts(
      { id: conn.id, account_id: s.account_id },
      { carts: [cart({ started_at: daysAgo(89) }), cart({ started_at: daysAgo(91) })] },
      new Date(NOW.getTime() - 5 * 86_400_000),
    );
    expect(await stored(conn.id)).toHaveLength(2);
    const out = await storeCarts(
      { id: conn.id, account_id: s.account_id },
      { carts: [cart({ started_at: daysAgo(92) })] },
      NOW,
    );
    // At NOW the 91-day cart goes, the 89-day one stays, and a 92-day one is never stored.
    expect(out).toEqual({ stored: 0, hashed: 0, pruned: 1 });
    const left = await stored(conn.id);
    expect(left.map((r) => r.day)).toEqual([daysAgo(89).slice(0, 10)]);
  });

  // Review 2026-10-30: compared as instants — a provider's time with an offset
  // sorted after the ISO cutoff as a string, so a cart past 90 days was kept.
  it("a start time with an offset is judged by its instant at the 90-day edge", async () => {
    const { s, conn } = await shopWith({});
    const edge = retentionCutoff(NOW).slice(0, 10); // 06:00Z that day
    const out = await storeCarts(
      { id: conn.id, account_id: s.account_id },
      {
        carts: [
          cart({ started_at: `${edge}T10:00:00+05:00` }), // 05:00Z: an hour past
          cart({ started_at: `${edge}T12:00:00+05:00` }), // 07:00Z: an hour inside
        ],
      },
      NOW,
    );
    expect(out.stored).toBe(1);
  });

  // Review 2026-10-30: the prune ran only after a successful sync.
  it("the weekly prune forgets old carts for a store whose syncs stopped; newer ones stay", async () => {
    const { s, conn } = await shopWith({});
    await storeCarts(
      { id: conn.id, account_id: s.account_id },
      { carts: [cart({ started_at: daysAgo(80) }), cart({ started_at: daysAgo(30) })] },
      NOW,
    );
    // Twenty days on, with no sync since.
    const later = new Date(NOW.getTime() + 20 * 86_400_000);
    expect(await pruneExpiredCarts(later)).toBeGreaterThanOrEqual(1);
    expect((await stored(conn.id)).map((r) => r.day)).toEqual([daysAgo(30).slice(0, 10)]);
  });

  it("disconnecting a store deletes its carts; another store's stay", async () => {
    const a = await shopWith({});
    const b = await shopWith({});
    for (const x of [a, b]) {
      await storeCarts({ id: x.conn.id, account_id: x.s.account_id }, { carts: [cart({})] }, NOW);
    }
    await disconnect(a.conn.id);
    expect(await stored(a.conn.id)).toHaveLength(0);
    expect(await stored(b.conn.id)).toHaveLength(1);
  });

  it("hashes an email a store gives and never stores it; an erased address isn't linked again", async () => {
    const { s, conn } = await shopWith({});
    const out = await storeCarts(
      { id: conn.id, account_id: s.account_id },
      { carts: [cart({ email: "Keen@Example.com" }), cart({ email: "gone@example.com" })] },
      NOW,
    );
    expect(out.hashed).toBe(2);
    const rows = await stored(conn.id);
    expect(JSON.stringify(rows)).not.toMatch(/example\.com/i);
    expect(rows.map((r) => r.email_hash).sort()).toEqual(
      [emailHash("keen@example.com"), emailHash("gone@example.com")].sort(),
    );

    // Erasing the contact deletes their carts, in the erasure.
    const gone = await addContact(s.account_id, {
      email: "gone@example.com",
      consent: { status: "explicit_consent", source: "checkout" },
    });
    await eraseContact(s.account_id, gone.id);
    let after = await stored(conn.id);
    expect(after.map((r) => r.email_hash)).toEqual([emailHash("keen@example.com")]);

    // The next read of the same cart lands without the erased hash.
    await storeCarts(
      { id: conn.id, account_id: s.account_id },
      { carts: [cart({ ref: "again", email: "gone@example.com" })] },
      NOW,
    );
    after = await stored(conn.id);
    expect(after.find((r) => r.checkout_ref === "again")?.email_hash).toBeNull();
  });
});
