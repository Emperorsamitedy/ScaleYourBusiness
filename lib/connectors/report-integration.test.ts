// P2-10 / P2-11 — Stripe's truth reaching the profile and the report.
//
// Session B's "done when" names three things, and each has a test here:
// revenue facts flip to measured with the estimate preserved in history;
// the report's arithmetic runs on those measured facts; and the report
// carries the stated-vs-measured delta (rule 11). Stripe is the recorded
// fake from providers/stripe-fake.ts, swapped in through the registry, so
// the real connect → sync → derive path runs end to end.

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
import {
  connectorSeriesId,
  displaySourceKind,
  isMeasuredSource,
  measuredProvider,
} from "./measured";
import type { BalanceTransaction } from "./providers/stripe";
import { createStripeProvider } from "./providers/stripe";
import { FAKE_STRIPE_KEY, fakeStripe, txn } from "./providers/stripe-fake";
import { overrideProviderForTests } from "./registry";
import { connect } from "./service";
import { measuredDelta, statedVsMeasured } from "./stated-vs-measured";
import { syncConnection } from "./sync";

const NOW = new Date("2026-09-14T12:00:00Z");
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
    await db.delete(businessProfiles).where(eq(businessProfiles.id, s.profile_id));
    await db.delete(accounts).where(eq(accounts.id, s.account_id));
  }
});

/** Thirty days of one €230.33 sale a day, one €9.90 refund, and a fee that is not a sale. */
function thirtyDaysOfSales(): BalanceTransaction[] {
  const ledger = Array.from({ length: 30 }, (_, i) =>
    txn(new Date(Date.UTC(2026, 7, 15, 14) + i * 86_400_000).toISOString(), 23_033),
  );
  ledger.push(txn("2026-09-13T18:00:00Z", -990, "refund"));
  ledger.push(txn("2026-09-13T19:00:00Z", -500, "fee"));
  return ledger;
}
const MEASURED_REVENUE = 30 * 23_033 - 990; // 690,000 minor units
const MEASURED_ORDERS = 30;

/** An intake account with a connected (fake) Stripe. */
async function stripeAccount(ledger: BalanceTransaction[] = thirtyDaysOfSales()) {
  restore = overrideProviderForTests(
    "stripe",
    createStripeProvider({ fetch: fakeStripe(ledger).fetch, sleep: async () => {} }),
  );
  const s = await bootstrapIntake();
  created.push(s);
  const conn = await connect(s.account_id, "stripe", FAKE_STRIPE_KEY);
  return { ...s, connection_id: conn.id, ledger };
}

async function ownerSays(
  profileId: string,
  key: string,
  value: unknown,
  note: string | null = null,
) {
  const at = isoDateTime("2026-08-01T10:00:00Z");
  await writeField(
    profileId,
    createField<unknown>({
      id: fieldId(key),
      value,
      status: value === null ? "unknown" : "answered",
      confidence: 0.75,
      source: { kind: "owner_input" },
      observed_at: at,
      recorded_at: at,
      note,
    }),
  );
}

describe("what counts as measured", () => {
  it("recognises connector sources, raw and aggregated, and nothing else", () => {
    const series = connectorSeriesId("stripe", "revenue.daily");
    expect(series).toBe("connector:stripe:revenue.daily");

    expect(isMeasuredSource({ kind: "inferred", derived_from: [series], method: "sum" })).toBe(
      true,
    );
    expect(isMeasuredSource({ kind: "connector", connector_id: "stripe" })).toBe(true);
    // Computed from the owner's own answers: not a measurement.
    expect(
      isMeasuredSource({
        kind: "inferred",
        derived_from: ["revenue.monthly_revenue"],
        method: "x",
      }),
    ).toBe(false);
    // Half measured, half answered is not measured.
    expect(
      isMeasuredSource({ kind: "inferred", derived_from: [series, "costs.rent"], method: "x" }),
    ).toBe(false);
    expect(isMeasuredSource({ kind: "owner_input" })).toBe(false);
    expect(isMeasuredSource(null)).toBe(false);
  });

  it("names the provider and the display kind", () => {
    const source = {
      kind: "inferred",
      derived_from: [connectorSeriesId("stripe", "orders.daily")],
      method: "sum",
    };
    expect(measuredProvider(source)).toBe("stripe");
    expect(displaySourceKind(source)).toBe("connector");
    expect(displaySourceKind({ kind: "owner_input" })).toBe("owner_input");
    expect(displaySourceKind(undefined)).toBe("unknown");
  });
});

describe("P2-10 — Stripe end to end", () => {
  it("measured revenue and orders supersede the owner's estimates, which stay in history", async () => {
    const s = await stripeAccount();
    await ownerSays(s.profile_id, "revenue.monthly_revenue", money(830_000, "EUR"), "roughly");
    await ownerSays(s.profile_id, "revenue.order_count_monthly", 150);

    const outcome = await syncConnection(s.connection_id, NOW);
    expect(outcome).toMatchObject({ ok: true, kind: "backfill", skipped: null });

    const revenue = await readCurrentField<Money>(s.profile_id, "revenue.monthly_revenue");
    expect(revenue?.value).toEqual({ amount_minor: MEASURED_REVENUE, currency: "EUR" });
    expect(revenue?.status).toBe("inferred");
    expect(isMeasuredSource(revenue?.source)).toBe(true);
    expect(measuredProvider(revenue?.source)).toBe("stripe");

    expect(
      (await readCurrentField<number>(s.profile_id, "revenue.order_count_monthly"))?.value,
    ).toBe(MEASURED_ORDERS);

    const history = await readFieldHistory<Money>(s.profile_id, "revenue.monthly_revenue");
    expect(history[0]?.field).toMatchObject({
      value: { amount_minor: 830_000, currency: "EUR" },
      status: "answered",
      note: "roughly",
    });
    expect(history[0]?.field.source.kind).toBe("owner_input");
  });

  it("Stripe has no ad spend, so that fact is refused rather than invented", async () => {
    const s = await stripeAccount();
    const outcome = await syncConnection(s.connection_id, NOW);
    expect(outcome.derived.find((d) => d.field_key === "marketing.monthly_ad_spend")?.outcome).toBe(
      "refused",
    );
    expect(await readCurrentField(s.profile_id, "marketing.monthly_ad_spend")).toBeNull();
  });

  it("the economics engine computes from measured facts with no owner answers at all", async () => {
    // Before Phase 2, economics read only "answered" facts, so a Stripe
    // figure would have been silently ignored and average order value refused.
    const s = await stripeAccount();
    await syncConnection(s.connection_id, NOW);

    const view = await readSnapshot((await ensureSnapshot(s.profile_id, "manual")).id);
    const economics = computeEconomics(view, "EUR");

    expect(economics.average_order_value?.value).toEqual({
      amount_minor: Math.round(MEASURED_REVENUE / MEASURED_ORDERS),
      currency: "EUR",
    });
    expect(economics.refusals.some((r) => r.what === "average order value")).toBe(false);
  });
});

describe("P2-11 — stated vs measured (rule 11)", () => {
  it("pairs each measured fact with what the owner said, and computes the delta", async () => {
    const s = await stripeAccount();
    await ownerSays(s.profile_id, "revenue.monthly_revenue", money(830_000, "EUR"), "roughly");
    await ownerSays(s.profile_id, "revenue.order_count_monthly", 150);
    await syncConnection(s.connection_id, NOW);

    const pairs = await statedVsMeasured((await ensureSnapshot(s.profile_id, "report")).id);
    expect(pairs.map((p) => p.field_key)).toEqual([
      "revenue.monthly_revenue",
      "revenue.order_count_monthly",
    ]);

    const [revenue, orders] = pairs;
    expect(revenue).toMatchObject({
      provider: "Stripe",
      stated: {
        value: { amount_minor: 830_000, currency: "EUR" },
        status: "answered",
        source_kind: "owner_input",
        note: "roughly",
      },
      measured: { value: { amount_minor: MEASURED_REVENUE, currency: "EUR" } },
      delta: { amount: MEASURED_REVENUE - 830_000, currency: "EUR", pct: -16.9 },
    });
    expect(revenue?.measured.method).toContain("sum(revenue.daily)");
    expect(orders?.delta).toEqual({ amount: MEASURED_ORDERS - 150, currency: null, pct: -80 });
  });

  it("an owner who said 'I don't know' is shown as such, with no delta", async () => {
    const s = await stripeAccount();
    await ownerSays(s.profile_id, "revenue.monthly_revenue", null);
    await syncConnection(s.connection_id, NOW);

    const [revenue] = await statedVsMeasured((await ensureSnapshot(s.profile_id, "report")).id);
    expect(revenue).toMatchObject({
      stated: { value: null, status: "unknown" },
      delta: null,
    });
  });

  it("an estimate in another currency is shown, but never subtracted (rule 1)", async () => {
    const s = await stripeAccount();
    await ownerSays(s.profile_id, "revenue.monthly_revenue", money(250_000_000, "HUF"));
    await syncConnection(s.connection_id, NOW);

    const [revenue] = await statedVsMeasured((await ensureSnapshot(s.profile_id, "report")).id);
    expect(revenue?.stated.value).toEqual({ amount_minor: 250_000_000, currency: "HUF" });
    expect(revenue?.delta).toBeNull();
  });

  it("finds the owner's estimate behind any number of later measurements", async () => {
    const s = await stripeAccount();
    await ownerSays(s.profile_id, "revenue.monthly_revenue", money(830_000, "EUR"));
    await syncConnection(s.connection_id, NOW);

    // New activity on the most recent day: the next run re-reads it and
    // writes a second measurement over the first.
    s.ledger.push(txn("2026-09-13T20:00:00Z", 10_000));
    await syncConnection(s.connection_id, NOW);

    const history = await readFieldHistory(s.profile_id, "revenue.monthly_revenue");
    expect(history).toHaveLength(3);

    const [revenue] = await statedVsMeasured((await ensureSnapshot(s.profile_id, "report")).id);
    expect(revenue?.stated.source_kind).toBe("owner_input");
    expect(revenue?.measured.value).toEqual({
      amount_minor: MEASURED_REVENUE + 10_000,
      currency: "EUR",
    });
  });

  it("a connector that filled an empty field has nothing to compare against", async () => {
    const s = await stripeAccount();
    await syncConnection(s.connection_id, NOW);
    expect(await statedVsMeasured((await ensureSnapshot(s.profile_id, "report")).id)).toEqual([]);
  });

  it("the delta arithmetic refuses what it cannot compare", () => {
    expect(measuredDelta(100, 80)).toEqual({ amount: -20, currency: null, pct: -20 });
    expect(measuredDelta(0, 80)).toEqual({ amount: 80, currency: null, pct: null });
    expect(measuredDelta(money(1_000, "EUR"), money(1_500, "EUR"))).toEqual({
      amount: 500,
      currency: "EUR",
      pct: 50,
    });
    expect(measuredDelta(money(1_000, "EUR"), money(1_000, "USD"))).toBeNull();
    expect(measuredDelta("a lot", money(1_000, "EUR"))).toBeNull();
  });
});
