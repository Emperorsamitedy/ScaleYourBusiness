// P2-05 — measured facts supersede owner estimates.
//
// This is the task the whole phase exists for, and its test is the one
// the plan spells out: "estimate survives in history with owner's name;
// current fact is measured; currencies never blend."
//
// Rules exercised: 3 (supersede, never overwrite), 6 (inferred values name
// their inputs and method), 1 (money never blends across currencies).

import "dotenv/config";
process.env.CONNECTOR_KEY ??= "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "../../db";
import {
  accounts,
  businessProfiles,
  connections,
  connectorSyncs,
  fieldRecords,
  metricObservations,
} from "../../db/schema";
import { createField } from "../core/field";
import { fieldId } from "../core/ids";
import { isoDate, isoDateTime } from "../core/iso";
import type { Money } from "../core/money";
import { money } from "../core/money";
import { bootstrapIntake } from "../intake/service";
import { readCurrentField, readFieldHistory, writeField } from "../profile/field-store";
import {
  CONNECTOR_CONFIDENCE,
  DERIVATIONS,
  deriveFactsFromObservations,
  trailingWindow,
} from "./derive";
import type { Observation } from "./provider";
import { FIXTURE_SECRET } from "./providers/fixture";
import { connect, upsertObservations } from "./service";

const created: { account_id: string; profile_id: string }[] = [];

async function scenario() {
  const s = await bootstrapIntake();
  created.push(s);
  const conn = await connect(s.account_id, "fixture", FIXTURE_SECRET);
  return { ...s, connection_id: conn.id };
}

/** The owner's own answer during the intake — precise input, §8.1 base 0.75. */
async function ownerSays(profileId: string, key: string, value: unknown, note?: string) {
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
      note: note ?? null,
    }),
  );
}

function dailyRevenue(date: string, minor: number, currency = "EUR"): Observation {
  return {
    metric_key: "revenue.daily",
    period_date: date,
    dimensions: { currency },
    value_minor: minor,
    observed_at: "2026-09-14T00:00:00Z",
  };
}

function dailyOrders(date: string, count: number): Observation {
  return {
    metric_key: "orders.daily",
    period_date: date,
    dimensions: {},
    value_num: count,
    observed_at: "2026-09-14T00:00:00Z",
  };
}

/** Thirty consecutive days ending 2026-09-13. */
const WINDOW = trailingWindow(isoDate("2026-09-13"));
const days = Array.from({ length: 30 }, (_, i) => {
  const d = new Date(Date.UTC(2026, 7, 15) + i * 86_400_000);
  return d.toISOString().slice(0, 10);
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
    await db.delete(fieldRecords).where(eq(fieldRecords.profile_id, s.profile_id));
    await db.delete(businessProfiles).where(eq(businessProfiles.id, s.profile_id));
    await db.delete(accounts).where(eq(accounts.id, s.account_id));
  }
});

describe("P2-05 — measured supersedes stated", () => {
  it("the owner's estimate survives in history; the current fact is measured", async () => {
    const s = await scenario();
    // The owner guessed 8,300.00 EUR a month during the intake.
    await ownerSays(s.profile_id, "revenue.monthly_revenue", money(830_000, "EUR"), "roughly");

    // Stripe-shaped truth: 30 days at 230.33 EUR = 6,910.00 EUR.
    await upsertObservations(
      s.connection_id,
      "fixture",
      days.map((d) => dailyRevenue(d, 23_033)),
    );

    const outcomes = await deriveFactsFromObservations(s.connection_id, WINDOW);
    const revenue = outcomes.find((o) => o.field_key === "revenue.monthly_revenue");
    expect(revenue?.outcome).toBe("written");

    // Current: measured, inferred, connector confidence, and it names its inputs.
    const current = await readCurrentField<Money>(s.profile_id, "revenue.monthly_revenue");
    expect(current?.value).toEqual({ amount_minor: 690_990, currency: "EUR" });
    expect(current?.status).toBe("inferred");
    expect(current?.confidence).toBeCloseTo(CONNECTOR_CONFIDENCE, 3);
    expect(current?.source.kind).toBe("inferred");
    if (current?.source.kind === "inferred") {
      // Rule 6: no unexplainable numbers.
      expect(current.source.derived_from).toContain("connector:fixture:revenue.daily");
      expect(current.source.method).toContain("sum(revenue.daily)");
      expect(current.source.method).toContain("30 days");
      expect(current.source.method).toContain(WINDOW.from);
      expect(current.source.method).toContain(WINDOW.to);
    }

    // History: the owner's figure is still there, still attributed to them.
    const history = await readFieldHistory<Money>(s.profile_id, "revenue.monthly_revenue");
    expect(history).toHaveLength(2);
    const estimate = history[0];
    expect(estimate?.field.value).toEqual({ amount_minor: 830_000, currency: "EUR" });
    expect(estimate?.field.source.kind).toBe("owner_input");
    expect(estimate?.field.status).toBe("answered");
    expect(estimate?.field.note).toBe("roughly");
    expect(estimate?.superseded_at).not.toBeNull();
  });

  it("counts are summed too, and an untouched metric is refused, not invented", async () => {
    const s = await scenario();
    await upsertObservations(
      s.connection_id,
      "fixture",
      days.map((d) => dailyOrders(d, 4)),
    );

    const outcomes = await deriveFactsFromObservations(s.connection_id, WINDOW);
    expect(outcomes.find((o) => o.field_key === "revenue.order_count_monthly")?.outcome).toBe(
      "written",
    );
    expect(
      await readCurrentField<number>(s.profile_id, "revenue.order_count_monthly"),
    ).toMatchObject({ value: 120, status: "inferred" });

    // No ad-spend observations exist: a refusal naming the gap, never a zero.
    const spend = outcomes.find((o) => o.field_key === "marketing.monthly_ad_spend");
    expect(spend?.outcome).toBe("refused");
    expect(spend).toMatchObject({ reason: expect.stringContaining("ad_spend.daily") });
    expect(await readCurrentField(s.profile_id, "marketing.monthly_ad_spend")).toBeNull();
  });

  it("re-deriving an unchanged window writes nothing (a daily cron is not 365 history rows)", async () => {
    const s = await scenario();
    await upsertObservations(
      s.connection_id,
      "fixture",
      days.map((d) => dailyRevenue(d, 10_000)),
    );

    expect((await deriveFactsFromObservations(s.connection_id, WINDOW))[0]?.outcome).toBe(
      "written",
    );
    for (let i = 0; i < 3; i++) {
      const again = await deriveFactsFromObservations(s.connection_id, WINDOW);
      expect(again.find((o) => o.field_key === "revenue.monthly_revenue")?.outcome).toBe(
        "unchanged",
      );
    }
    const history = await readFieldHistory(s.profile_id, "revenue.monthly_revenue");
    expect(history).toHaveLength(1);
  });

  it("survives Postgres reordering JSONB keys", async () => {
    // Regression: Money is written {amount_minor, currency} and reads back
    // {currency, amount_minor}. A stringify-based comparison saw that as a
    // change and rewrote the fact on every single cron run.
    const s = await scenario();
    await upsertObservations(s.connection_id, "fixture", [dailyRevenue(days[0] as string, 12_345)]);
    await deriveFactsFromObservations(s.connection_id, WINDOW);

    const [row] = await db
      .select({ value: fieldRecords.value })
      .from(fieldRecords)
      .where(eq(fieldRecords.profile_id, s.profile_id));
    // Prove the premise: storage really does hand the keys back reordered.
    expect(Object.keys(row?.value as object)).not.toEqual(["amount_minor", "currency"]);

    expect(
      (await deriveFactsFromObservations(s.connection_id, WINDOW)).find(
        (o) => o.field_key === "revenue.monthly_revenue",
      )?.outcome,
    ).toBe("unchanged");
  });

  it("a changed figure DOES supersede — unchanged is not a cache", async () => {
    const s = await scenario();
    await upsertObservations(s.connection_id, "fixture", [dailyRevenue(days[0] as string, 10_000)]);
    await deriveFactsFromObservations(s.connection_id, WINDOW);
    // The provider corrects the day upward.
    await upsertObservations(s.connection_id, "fixture", [dailyRevenue(days[0] as string, 99_000)]);
    await deriveFactsFromObservations(s.connection_id, WINDOW);

    const history = await readFieldHistory<Money>(s.profile_id, "revenue.monthly_revenue");
    expect(history).toHaveLength(2);
    expect(history[1]?.field.value).toEqual({ amount_minor: 99_000, currency: "EUR" });
  });
});

describe("P2-05 — rule 1 holds at the connector boundary", () => {
  it("refuses to total a window holding two currencies, and leaves the owner's figure current", async () => {
    const s = await scenario();
    await ownerSays(s.profile_id, "revenue.monthly_revenue", money(830_000, "HUF"));
    await upsertObservations(s.connection_id, "fixture", [
      dailyRevenue(days[0] as string, 10_000, "EUR"),
      dailyRevenue(days[1] as string, 10_000, "HUF"),
    ]);

    const outcomes = await deriveFactsFromObservations(s.connection_id, WINDOW);
    const revenue = outcomes.find((o) => o.field_key === "revenue.monthly_revenue");
    expect(revenue?.outcome).toBe("refused");
    expect(revenue).toMatchObject({ reason: expect.stringContaining("currencies never blend") });

    // The owner's answer was not replaced by a nonsense blend.
    const current = await readCurrentField<Money>(s.profile_id, "revenue.monthly_revenue");
    expect(current?.source.kind).toBe("owner_input");
    expect(current?.value).toEqual({ amount_minor: 830_000, currency: "HUF" });
  });

  it("refuses everything when there are no observations at all", async () => {
    const s = await scenario();
    const outcomes = await deriveFactsFromObservations(s.connection_id);
    expect(outcomes).toHaveLength(DERIVATIONS.length);
    expect(outcomes.every((o) => o.outcome === "refused")).toBe(true);
    expect(outcomes[0]).toMatchObject({ reason: "no observations yet" });
  });
});

describe("trailingWindow", () => {
  it("is inclusive of both ends and thirty days long by default", () => {
    const w = trailingWindow(isoDate("2026-09-30"));
    expect(w).toEqual({ from: "2026-09-01", to: "2026-09-30" });
  });
});
