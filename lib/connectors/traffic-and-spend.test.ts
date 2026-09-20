// P2-18 / P2-19 / P2-21 — traffic and spend reaching the profile and the
// report, end to end against the recorded-shape Google Analytics and Meta.
//
// Session D's "done when": the FTGU-class finding, "you advertise but can't
// measure if it pays off", can be answered by the system itself. The chain
// walked here: Meta measures spend and attributed purchases, a store or
// Stripe measures revenue and orders, and the economics engine computes
// cost per acquisition and return on ad spend from measured inputs, with
// refusals when either side is missing. Alongside: GA4 sessions become
// business-wide and per-channel measured facts through the same confirm-
// the-mapping pattern as products.

import "dotenv/config";
process.env.CONNECTOR_KEY ??= "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { eq } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { db } from "../../db";
import {
  accounts,
  businessProfiles,
  channels,
  connections,
  connectorSyncs,
  fieldRecords,
  metricObservations,
  profileSnapshots,
} from "../../db/schema";
import { createField } from "../core/field";
import { fieldId } from "../core/ids";
import { isoDateTime } from "../core/iso";
import type { Money } from "../core/money";
import { money } from "../core/money";
import { computeEconomics } from "../economics/unit-economics";
import { bootstrapIntake } from "../intake/service";
import { readCurrentField, readFieldHistory, writeField } from "../profile/field-store";
import { ensureSnapshot, readSnapshot } from "../profile/snapshot";
import { COST_PER_PURCHASE_KEY } from "./derive";
import { channelSimilarity, confirmMapping, mappingKey, mappingView } from "./mapping";
import { isMeasuredSource } from "./measured";
import { createGa4Provider } from "./providers/ga4";
import { fakeGa4, makeServiceAccount } from "./providers/ga4-fake";
import { createMetaAdsProvider } from "./providers/meta-ads";
import { FAKE_META_SECRET, fakeMeta } from "./providers/meta-fake";
import { createStripeProvider } from "./providers/stripe";
import { FAKE_STRIPE_KEY, fakeStripe, txn } from "./providers/stripe-fake";
import { overrideProviderForTests } from "./registry";
import { connect } from "./service";
import { statedVsMeasured } from "./stated-vs-measured";
import { syncConnection } from "./sync";

const NOW = new Date("2026-09-14T12:00:00Z");
const PROPERTY = "412345678";
const ACCOUNT = makeServiceAccount();
const GA4_SECRET = JSON.stringify({ property_id: PROPERTY, service_account_json: ACCOUNT.json });
const created: { account_id: string; profile_id: string }[] = [];
const restores: (() => void)[] = [];

afterEach(() => {
  for (const restore of restores.splice(0)) restore();
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
    await db.delete(channels).where(eq(channels.profile_id, s.profile_id));
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

async function addChannel(profileId: string, type: string, platform: string | null) {
  const [row] = await db.insert(channels).values({ profile_id: profileId }).returning();
  if (!row) throw new Error("channel insert failed");
  await ownerSays(profileId, `channels.${row.id}.type`, { code: type });
  if (platform !== null)
    await ownerSays(profileId, `channels.${row.id}.platform`, { code: platform });
  return row.id;
}

/** Thirty days: 20 organic-search, 10 paid-social and 5 direct sessions a day. */
function thirtyDaysOfTraffic() {
  return Array.from({ length: 30 }, (_, i) => {
    const date = new Date(Date.UTC(2026, 7, 15) + i * 86_400_000).toISOString().slice(0, 10);
    return [
      { date, channel: "Organic Search", sessions: 20 },
      { date, channel: "Paid Social", sessions: 10 },
      { date, channel: "Direct", sessions: 5 },
    ];
  }).flat();
}

/** Thirty days at €30 spend and one attributed purchase a day. */
function thirtyDaysOfAds() {
  return Array.from({ length: 30 }, (_, i) => ({
    date: new Date(Date.UTC(2026, 7, 15) + i * 86_400_000).toISOString().slice(0, 10),
    spend: "30.00",
    actions: [
      { action_type: "link_click", value: "40" },
      { action_type: "omni_purchase", value: "1" },
      { action_type: "purchase", value: "1" },
    ],
  }));
}

/** Thirty days at one €200 sale a day. */
function thirtyDaysOfSales() {
  return Array.from({ length: 30 }, (_, i) =>
    txn(new Date(Date.UTC(2026, 7, 15, 14) + i * 86_400_000).toISOString(), 20_000),
  );
}

async function account() {
  const s = await bootstrapIntake();
  created.push(s);
  return s;
}

function useGa4(rows = thirtyDaysOfTraffic()) {
  const fake = fakeGa4({ account: ACCOUNT, propertyId: PROPERTY, rows });
  restores.push(
    overrideProviderForTests(
      "ga4",
      createGa4Provider({ fetch: fake.fetch, sleep: async () => {}, clock: () => NOW.getTime() }),
    ),
  );
}

function useMeta(days = thirtyDaysOfAds()) {
  const fake = fakeMeta({ days });
  restores.push(
    overrideProviderForTests(
      "meta_ads",
      createMetaAdsProvider({ fetch: fake.fetch, sleep: async () => {} }),
    ),
  );
}

function useStripe() {
  const fake = fakeStripe(thirtyDaysOfSales());
  restores.push(
    overrideProviderForTests(
      "stripe",
      createStripeProvider({ fetch: fake.fetch, sleep: async () => {} }),
    ),
  );
}

describe("P2-18 — channel matching", () => {
  it("scores GA4 channel groups against the owner's channel type and platform", () => {
    expect(channelSimilarity("Paid Social", "paid_ads", "meta_ads")).toBe(1);
    expect(channelSimilarity("Paid Search", "paid_ads", "meta_ads")).toBe(0.6);
    expect(channelSimilarity("Organic Search", "website", null)).toBe(0.6);
    expect(channelSimilarity("Paid Social", "social_organic", "instagram")).toBe(0);
    expect(channelSimilarity("Unassigned", "website", "own_website")).toBe(0);
  });

  it("suggests the right channel, the owner confirms, and both figures become measured", async () => {
    useGa4();
    const s = await account();
    const ads = await addChannel(s.profile_id, "paid_ads", "meta_ads");
    const site = await addChannel(s.profile_id, "website", "own_website");
    const stall = await addChannel(s.profile_id, "physical_store", null);
    const conn = await connect(s.account_id, "ga4", GA4_SECRET);

    const view = await mappingView(s.account_id, conn.id);
    expect(view.kind).toBe("channel");
    const row = (id: string) => view.entities.find((e) => e.entity_id === id);
    expect(row(ads)?.name).toBe("paid ads · meta ads");
    expect(row(ads)?.suggestion?.ref).toBe("Paid Social");
    expect(["Organic Search", "Direct"]).toContain(row(site)?.suggestion?.ref);
    expect(row(stall)?.suggestion).toBeNull();

    await confirmMapping({
      accountId: s.account_id,
      connectionId: conn.id,
      entityId: ads,
      ref: "Paid Social",
    });
    await confirmMapping({
      accountId: s.account_id,
      connectionId: conn.id,
      entityId: site,
      ref: "Organic Search",
    });
    expect(await readCurrentField(s.profile_id, mappingKey(ads, "ga4", "channel"))).toMatchObject({
      status: "answered",
      value: { channel_ref: "Paid Social", label_raw: "Paid Social" },
    });

    const outcome = await syncConnection(conn.id, NOW);
    expect(outcome.ok).toBe(true);

    // Business-wide: the sum of every channel, not the matched ones only.
    const total = await readCurrentField<number>(s.profile_id, "presence.monthly_sessions");
    expect(total?.value).toBe(30 * 35);
    expect(isMeasuredSource(total?.source)).toBe(true);

    // Per channel: only the matched ones; the market stall gets no figure.
    expect(
      (await readCurrentField<number>(s.profile_id, `channels.${ads}.monthly_sessions`))?.value,
    ).toBe(300);
    expect(
      (await readCurrentField<number>(s.profile_id, `channels.${site}.monthly_sessions`))?.value,
    ).toBe(600);
    expect(await readCurrentField(s.profile_id, `channels.${stall}.monthly_sessions`)).toBeNull();

    // "Direct" is traffic nobody claimed: a visible gap.
    const after = await mappingView(s.account_id, conn.id);
    expect(after.unmapped_items.map((i) => i.ref)).toEqual(["Direct"]);
  });
});

describe("P2-19 / P2-21 — spend, purchases, and what the ads pay back", () => {
  it("Meta measures spend and cost per purchase, superseding the owner's estimates", async () => {
    useMeta();
    const s = await account();
    await ownerSays(s.profile_id, "marketing.monthly_ad_spend", money(50_000, "EUR"));
    await ownerSays(s.profile_id, COST_PER_PURCHASE_KEY, money(2_000, "EUR"));
    const conn = await connect(s.account_id, "meta_ads", FAKE_META_SECRET);

    const outcome = await syncConnection(conn.id, NOW);
    expect(outcome.ok).toBe(true);

    const spend = await readCurrentField<Money>(s.profile_id, "marketing.monthly_ad_spend");
    expect(spend?.value).toEqual({ amount_minor: 90_000, currency: "EUR" });
    expect(isMeasuredSource(spend?.source)).toBe(true);

    // 30 × €30 over 30 purchases: omni_purchase used, purchase not added on top.
    const cpp = await readCurrentField<Money>(s.profile_id, COST_PER_PURCHASE_KEY);
    expect(cpp?.value).toEqual({ amount_minor: 3_000, currency: "EUR" });
    expect((await readFieldHistory(s.profile_id, COST_PER_PURCHASE_KEY))[0]?.field).toMatchObject({
      value: { amount_minor: 2_000, currency: "EUR" },
      status: "answered",
    });

    const pairs = await statedVsMeasured((await ensureSnapshot(s.profile_id, "report")).id);
    expect(pairs.map((p) => p.field_key)).toEqual([
      "marketing.monthly_ad_spend",
      COST_PER_PURCHASE_KEY,
    ]);
    expect(pairs[1]?.delta).toEqual({ amount: 1_000, currency: "EUR", pct: 50 });
  });

  it("with no attributed purchases, cost per purchase is refused, never divided by zero", async () => {
    useMeta(thirtyDaysOfAds().map((d) => ({ ...d, actions: [] })));
    const s = await account();
    const conn = await connect(s.account_id, "meta_ads", FAKE_META_SECRET);
    const outcome = await syncConnection(conn.id, NOW);
    const cpp = outcome.derived.find((d) => d.field_key === COST_PER_PURCHASE_KEY);
    expect(cpp?.outcome).toBe("refused");
    expect(cpp).toMatchObject({ reason: expect.stringContaining("no purchases") });
    expect(await readCurrentField(s.profile_id, COST_PER_PURCHASE_KEY)).toBeNull();
  });

  it("THE DONE-WHEN: with Stripe revenue and Meta spend both measured, the report answers whether the ads pay off", async () => {
    useMeta();
    useStripe();
    const s = await account();
    await ownerSays(s.profile_id, "revenue.repeat_customer_rate", 20);
    const stripe = await connect(s.account_id, "stripe", FAKE_STRIPE_KEY);
    const meta = await connect(s.account_id, "meta_ads", FAKE_META_SECRET);
    await syncConnection(stripe.id, NOW);
    await syncConnection(meta.id, NOW);

    const view = await readSnapshot((await ensureSnapshot(s.profile_id, "report")).id);
    const economics = computeEconomics(view, "EUR");

    // €6,000 revenue over €900 spend.
    expect(economics.return_on_ad_spend?.value).toBe(6.67);
    expect(economics.return_on_ad_spend?.derived_from).toEqual([
      "revenue.monthly_revenue",
      "marketing.monthly_ad_spend",
    ]);
    // €900 over 30 orders × 80% new customers = €37.50.
    expect(economics.cost_per_acquisition?.value).toEqual({ amount_minor: 3_750, currency: "EUR" });
    expect(economics.refusals.some((r) => r.what === "return on ad spend")).toBe(false);
    expect(economics.refusals.some((r) => r.what === "cost per acquisition")).toBe(false);
  });

  it("with spend measured but no revenue at all, return on ad spend is refused", async () => {
    useMeta();
    const s = await account();
    const meta = await connect(s.account_id, "meta_ads", FAKE_META_SECRET);
    await syncConnection(meta.id, NOW);

    const view = await readSnapshot((await ensureSnapshot(s.profile_id, "report")).id);
    const economics = computeEconomics(view, "EUR");
    expect(economics.return_on_ad_spend).toBeNull();
    expect(economics.refusals.find((r) => r.what === "return on ad spend")?.missing).toEqual([
      "revenue.monthly_revenue",
    ]);
  });
});
