// P2-15 / P2-16 — product matching, and measured units per offer.
//
// Session C's "done when" is that per-offer measured volume renders in the
// report's numbers with a measured source. The chain these tests walk:
// the system suggests matches by name, the owner confirms them (a fact
// with the owner as its source), a sync reads the store's units per
// product, and derivation turns them into each matched offer's monthly
// volume, superseding the owner's estimate and feeding the economics.

import "dotenv/config";
process.env.CONNECTOR_KEY ??= "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { eq } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { db } from "../../db";
import {
  accounts,
  businessProfiles,
  connections,
  connectorSyncs,
  fieldRecords,
  metricObservations,
  offers,
  profileSnapshots,
} from "../../db/schema";
import { createField } from "../core/field";
import { fieldId } from "../core/ids";
import { isoDateTime } from "../core/iso";
import { money } from "../core/money";
import { computeEconomics } from "../economics/unit-economics";
import { bootstrapIntake } from "../intake/service";
import { readCurrentField, readFieldHistory, writeField } from "../profile/field-store";
import { ensureSnapshot, readSnapshot } from "../profile/snapshot";
import {
  confirmMapping,
  mappingKey,
  mappingView,
  normaliseTitle,
  suggestMatches,
  titleSimilarity,
} from "./mapping";
import { isMeasuredSource } from "./measured";
import { createShopifyProvider } from "./providers/shopify";
import type { FakeShopifyOrder } from "./providers/shopify-fake";
import { FAKE_SHOPIFY_SECRET, fakeShopify, shopOrder } from "./providers/shopify-fake";
import { overrideProviderForTests } from "./registry";
import { connect } from "./service";
import { statedVsMeasured } from "./stated-vs-measured";
import { syncConnection } from "./sync";

const NOW = new Date("2026-09-14T12:00:00Z");
const CANDLE = "gid://shopify/Product/101";
const DIFFUSER = "gid://shopify/Product/102";
const MUG = "gid://shopify/Product/103";
const created: { account_id: string; profile_id: string }[] = [];
let restore: (() => void) | null = null;

afterEach(() => {
  restore?.();
  restore = null;
});

afterAll(async () => {
  for (const s of created) {
    const rows = await db
      .select({ id: connections.id })
      .from(connections)
      .where(eq(connections.account_id, s.account_id));
    for (const { id } of rows) {
      await db.delete(metricObservations).where(eq(metricObservations.connection_id, id));
      await db.delete(connectorSyncs).where(eq(connectorSyncs.connection_id, id));
    }
    await db.delete(connections).where(eq(connections.account_id, s.account_id));
    await db.delete(profileSnapshots).where(eq(profileSnapshots.profile_id, s.profile_id));
    await db.delete(fieldRecords).where(eq(fieldRecords.profile_id, s.profile_id));
    await db.delete(offers).where(eq(offers.profile_id, s.profile_id));
    await db.delete(businessProfiles).where(eq(businessProfiles.id, s.profile_id));
    await db.delete(accounts).where(eq(accounts.id, s.account_id));
  }
});

async function ownerSays(profileId: string, key: string, value: unknown) {
  const at = isoDateTime("2026-08-01T10:00:00Z");
  await writeField(
    profileId,
    createField<unknown>({
      id: fieldId(key),
      value,
      status: "answered",
      confidence: 0.75,
      source: { kind: "owner_input" },
      observed_at: at,
      recorded_at: at,
      note: null,
    }),
  );
}

async function addOffer(profileId: string, name: string, priceMinor: number | null = null) {
  const [row] = await db
    .insert(offers)
    .values({ profile_id: profileId, kind: "physical" })
    .returning();
  if (!row) throw new Error("offer insert failed");
  await ownerSays(profileId, `offers.${row.id}.name`, name);
  if (priceMinor !== null)
    await ownerSays(profileId, `offers.${row.id}.price`, money(priceMinor, "EUR"));
  return row.id;
}

/** Ten orders in the last 30 days: 2 candles each, and 1 diffuser in every other order. */
function recentOrders(): FakeShopifyOrder[] {
  return Array.from({ length: 10 }, (_, i) =>
    shopOrder(new Date(Date.UTC(2026, 8, 1 + i, 10)).toISOString(), "60.00", [
      { quantity: 2, productId: CANDLE },
      ...(i % 2 === 0 ? [{ quantity: 1, productId: DIFFUSER }] : []),
    ]),
  );
}

async function store() {
  const shop = fakeShopify({
    now: NOW,
    orders: recentOrders(),
    products: [
      { id: CANDLE, title: "Cedar & Smoke Candle", status: "ACTIVE" },
      { id: DIFFUSER, title: "Reed Diffuser (200 ml)", status: "ACTIVE" },
      { id: MUG, title: "Stoneware Mug", status: "ACTIVE" },
    ],
  });
  restore = overrideProviderForTests(
    "shopify",
    createShopifyProvider({ fetch: shop.fetch, sleep: async () => {} }),
  );
  const s = await bootstrapIntake();
  created.push(s);
  const candle = await addOffer(s.profile_id, "Cedar and Smoke candle", 3_000);
  const diffuser = await addOffer(s.profile_id, "Reed diffuser 200ml", 4_500);
  const soap = await addOffer(s.profile_id, "Oat soap bar");
  const conn = await connect(s.account_id, "shopify", FAKE_SHOPIFY_SECRET);
  return { ...s, connection_id: conn.id, candle, diffuser, soap };
}

describe("P2-15 — suggesting matches, without a model", () => {
  it("normalises accents, punctuation and case", () => {
    expect(normaliseTitle("Szörp  0.5L — Bodza!")).toBe("szorp 0 5l bodza");
  });

  it("treats spacing-only differences as the same name", () => {
    expect(titleSimilarity("Reed diffuser 200ml", "Reed Diffuser (200 ml)")).toBe(1);
    expect(
      titleSimilarity("Cedar and Smoke candle", "Cedar & Smoke Candle"),
    ).toBeGreaterThanOrEqual(0.5);
    expect(titleSimilarity("Oat soap bar", "Stoneware Mug")).toBe(0);
  });

  it("suggests one-to-one, strongest first, and leaves weak matches unsuggested", () => {
    const suggestions = suggestMatches(
      [
        { entity_id: "a", name: "Candle" },
        { entity_id: "b", name: "Candle gift set" },
        { entity_id: "c", name: "Oat soap" },
      ],
      [
        { ref: "p1", title: "candle", status: null },
        { ref: "p2", title: "Candle Gift Set", status: null },
        { ref: "p3", title: "Mug", status: null },
      ],
    );
    expect(suggestions.map((s) => [s.entity_id, s.item.ref])).toEqual([
      ["a", "p1"],
      ["b", "p2"],
    ]);
  });
});

describe("P2-15 — the owner confirms, and it becomes a fact", () => {
  it("shows suggestions, stores a confirmed match as the owner's fact, and records 'no match' too", async () => {
    const s = await store();
    const view = await mappingView(s.account_id, s.connection_id);

    const row = (id: string) => view.entities.find((o) => o.entity_id === id);
    expect(row(s.candle)?.suggestion?.ref).toBe(CANDLE);
    expect(row(s.diffuser)?.suggestion?.ref).toBe(DIFFUSER);
    expect(row(s.soap)?.suggestion).toBeNull();

    // Nothing is stored until the owner confirms.
    expect(await readCurrentField(s.profile_id, mappingKey(s.candle, "shopify"))).toBeNull();

    const after = await confirmMapping({
      accountId: s.account_id,
      connectionId: s.connection_id,
      entityId: s.candle,
      ref: CANDLE,
    });
    const fact = await readCurrentField(s.profile_id, mappingKey(s.candle, "shopify"));
    expect(fact).toMatchObject({
      status: "answered",
      value: { product_ref: CANDLE, label_raw: "Cedar & Smoke Candle" },
    });
    expect(fact?.source.kind).toBe("owner_input");
    expect(after.entities.find((o) => o.entity_id === s.candle)?.mapped?.ref).toBe(CANDLE);

    await confirmMapping({
      accountId: s.account_id,
      connectionId: s.connection_id,
      entityId: s.soap,
      ref: null,
    });
    expect(await readCurrentField(s.profile_id, mappingKey(s.soap, "shopify"))).toMatchObject({
      status: "not_applicable",
      value: null,
    });
  });

  it("refuses a product already matched to another offer, or not in the store", async () => {
    const s = await store();
    await confirmMapping({
      accountId: s.account_id,
      connectionId: s.connection_id,
      entityId: s.candle,
      ref: CANDLE,
    });
    await expect(
      confirmMapping({
        accountId: s.account_id,
        connectionId: s.connection_id,
        entityId: s.diffuser,
        ref: CANDLE,
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      confirmMapping({
        accountId: s.account_id,
        connectionId: s.connection_id,
        entityId: s.diffuser,
        ref: "gid://shopify/Product/999",
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("lists store products nobody matched as a visible gap", async () => {
    const s = await store();
    await confirmMapping({
      accountId: s.account_id,
      connectionId: s.connection_id,
      entityId: s.candle,
      ref: CANDLE,
    });
    const view = await mappingView(s.account_id, s.connection_id);
    expect(view.unmapped_items.map((p) => p.ref).sort()).toEqual([DIFFUSER, MUG]);
  });

  it("another account cannot see or change this store's matches", async () => {
    const s = await store();
    const stranger = await bootstrapIntake();
    created.push(stranger);
    await expect(mappingView(stranger.account_id, s.connection_id)).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe("P2-16 — measured units per offer", () => {
  it("a matched offer's volume becomes measured, supersedes the estimate, and feeds the economics", async () => {
    const s = await store();
    await ownerSays(s.profile_id, `offers.${s.candle}.volume_period`, 50);
    await confirmMapping({
      accountId: s.account_id,
      connectionId: s.connection_id,
      entityId: s.candle,
      ref: CANDLE,
    });
    await confirmMapping({
      accountId: s.account_id,
      connectionId: s.connection_id,
      entityId: s.diffuser,
      ref: DIFFUSER,
    });

    const outcome = await syncConnection(s.connection_id, NOW);
    expect(outcome.ok).toBe(true);

    const volumes = outcome.derived.filter((d) => d.field_key.endsWith(".volume_period"));
    expect(volumes.map((d) => [d.field_key, d.outcome]).sort()).toEqual(
      [
        [`offers.${s.candle}.volume_period`, "written"],
        [`offers.${s.diffuser}.volume_period`, "written"],
      ].sort(),
    );
    // The unmatched soap gets no volume at all: a gap, not a guess.
    expect(outcome.derived.some((d) => d.field_key === `offers.${s.soap}.volume_period`)).toBe(
      false,
    );

    const candle = await readCurrentField<number>(s.profile_id, `offers.${s.candle}.volume_period`);
    expect(candle?.value).toBe(20);
    expect(isMeasuredSource(candle?.source)).toBe(true);
    expect(
      (await readCurrentField<number>(s.profile_id, `offers.${s.diffuser}.volume_period`))?.value,
    ).toBe(5);

    const history = await readFieldHistory(s.profile_id, `offers.${s.candle}.volume_period`);
    expect(history[0]?.field).toMatchObject({ value: 50, status: "answered" });

    const view = await readSnapshot((await ensureSnapshot(s.profile_id, "report")).id);
    const economics = computeEconomics(view, "EUR");
    expect(economics.offers.find((o) => o.offer_id === s.candle)?.volume).toBe(20);

    const pairs = await statedVsMeasured(view.summary.id);
    expect(pairs.find((p) => p.field_key === `offers.${s.candle}.volume_period`)).toMatchObject({
      provider: "Shopify",
      stated: { value: 50 },
      measured: { value: 20 },
      delta: { amount: -30, pct: -60 },
    });
  });

  it("re-matching an offer changes its measured volume on the next derivation", async () => {
    const s = await store();
    await confirmMapping({
      accountId: s.account_id,
      connectionId: s.connection_id,
      entityId: s.candle,
      ref: CANDLE,
    });
    await syncConnection(s.connection_id, NOW);
    expect(
      (await readCurrentField<number>(s.profile_id, `offers.${s.candle}.volume_period`))?.value,
    ).toBe(20);

    await confirmMapping({
      accountId: s.account_id,
      connectionId: s.connection_id,
      entityId: s.candle,
      ref: DIFFUSER,
    });
    await syncConnection(s.connection_id, NOW);
    expect(
      (await readCurrentField<number>(s.profile_id, `offers.${s.candle}.volume_period`))?.value,
    ).toBe(5);
  });

  it("a product with no sales in the window measures zero, because the orders were read", async () => {
    const s = await store();
    await confirmMapping({
      accountId: s.account_id,
      connectionId: s.connection_id,
      entityId: s.soap,
      ref: MUG,
    });
    await syncConnection(s.connection_id, NOW);
    expect(
      await readCurrentField<number>(s.profile_id, `offers.${s.soap}.volume_period`),
    ).toMatchObject({
      value: 0,
      status: "inferred",
    });
  });

  it("business-wide revenue ignores per-product rows, so nothing is counted twice", async () => {
    const s = await store();
    await syncConnection(s.connection_id, NOW);
    expect(await readCurrentField(s.profile_id, "revenue.monthly_revenue")).toMatchObject({
      value: { amount_minor: 60_000, currency: "EUR" },
    });
    expect(await readCurrentField(s.profile_id, "revenue.order_count_monthly")).toMatchObject({
      value: 10,
    });
  });
});
