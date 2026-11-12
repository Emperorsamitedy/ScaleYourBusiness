// The Peer Benchmark Network — the v1 build spec §5, its acceptance
// criteria (§5.7) and the Phase 4 gate: a cohort of 6 returns nothing
// through every path, and the extraction attack can't isolate a business.

import "dotenv/config";
import { inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "../../db";
import {
  accounts,
  businessProfiles,
  connections,
  fieldRecords,
  intakeEvents,
  metricObservations,
  peerBenchmarkConsents,
} from "../../db/schema";
import { upsertObservations } from "../connectors/service";
import type { Observation } from "../connectors/provider";
import { confidence } from "../core/confidence";
import { createField } from "../core/field";
import { fieldId } from "../core/ids";
import { isoDateTime } from "../core/iso";
import { money } from "../core/money";
import { bootstrapIntake } from "../intake/service";
import { writeField } from "../profile/field-store";
import {
  BAND_IDS,
  type CohortSpec,
  type Member,
  bandOf,
  cohortLadder,
  distribution,
  naceAt,
  percentileOf,
} from "./cohort";
import { cohortQuery, peerBenchmarks } from "./benchmark";
import { optOutOfPeers } from "./consent";
import { lastCompleteMonth } from "./pool";
import { peerAverageOrderValue } from "./serve";

// ── Pure ──────────────────────────────────────────────────────────────────

const member = (
  i: number,
  value: number,
  revenue = 1_000_000,
  over: Partial<Member> = {},
): Member => ({
  business: `b${i}`,
  nace: "56.30",
  country: "PT",
  band: "150k_500k",
  revenue_eur_minor: revenue,
  values: {
    average_order_value: { value, numerator: revenue, denominator: 100, currency: "EUR" },
  },
  ...over,
});
const seven = (values = [10, 20, 30, 40, 50, 60, 70]) => values.map((v, i) => member(i, v));

describe("§5.1 — the cohort ladder, deterministic and recorded", () => {
  it("NACE 4 → 3 → 2, then country → region, then band → every band", () => {
    const ladder = cohortLadder({ nace: "56.30", country: "PT", band: "150k_500k" });
    expect(ladder.map((r) => [r.spec.nace, r.spec.geography, r.spec.band, r.widened])).toEqual([
      ["56.30", { kind: "country", code: "PT" }, "150k_500k", []],
      ["56.3", { kind: "country", code: "PT" }, "150k_500k", ["nace_3"]],
      ["56", { kind: "country", code: "PT" }, "150k_500k", ["nace_3", "nace_2"]],
      [
        "56",
        { kind: "region", id: "Iberia", countries: ["ES", "PT"] },
        "150k_500k",
        ["nace_3", "nace_2", "region"],
      ],
      [
        "56",
        { kind: "region", id: "Iberia", countries: ["ES", "PT"] },
        "any",
        ["nace_3", "nace_2", "region", "any_band"],
      ],
    ]);
    // The same input, the same ladder, every time.
    expect(cohortLadder({ nace: "56.30", country: "PT", band: "150k_500k" })).toEqual(ladder);
  });

  it("FR is a region of one, a country in no group never widens past itself, a section letter has one level", () => {
    expect(
      cohortLadder({ nace: "47", country: "FR", band: "under_50k" }).map((r) => r.widened),
    ).toEqual([[], ["any_band"]]);
    expect(cohortLadder({ nace: "F", country: "IE", band: "any" }).map((r) => r.spec.nace)).toEqual(
      ["F"],
    );
    expect(naceAt("56.30", 3)).toBe("56.3");
    expect(naceAt("47", 4)).toBeNull();
  });

  it("revenue bands are §5.1's, on a year in euro cents", () => {
    expect(BAND_IDS).toEqual([
      "under_50k",
      "50k_150k",
      "150k_500k",
      "500k_1_5m",
      "1_5m_5m",
      "over_5m",
    ]);
    expect(bandOf(4_999_999)).toBe("under_50k");
    expect(bandOf(5_000_000)).toBe("50k_150k");
    expect(bandOf(600_000_000)).toBe("over_5m");
  });
});

describe("§5.2 / §5.3 — the floor, and a distribution, never an average", () => {
  it("six serve exactly nothing", () => {
    const d = distribution(seven().slice(0, 6), "average_order_value", "EUR");
    expect(d).toEqual({ shown: false });
    expect(Object.keys(d)).toEqual(["shown"]);
  });

  it("seven serve p25, p50, p75 and the reader's percentile — and no member's value", () => {
    const d = distribution(seven(), "average_order_value", "EUR", 45);
    expect(d).toEqual({
      shown: true,
      p25: 25,
      p50: 40,
      p75: 55,
      businesses: 7,
      currency: "EUR",
      own_percentile: 57,
    });
    expect(percentileOf([10, 20, 30], 20)).toBe(50);
  });

  it("one business at 40% of the cohort's revenue serves nothing; exactly 25% serves", () => {
    const heavy = seven().map((m, i) => (i === 0 ? { ...m, revenue_eur_minor: 4_000_000 } : m));
    // 4.0m of 4.0m + 6 × 1.0m = 40 %
    expect(distribution(heavy, "average_order_value", "EUR")).toEqual({ shown: false });
    const quarter = seven().map((m, i) => (i === 0 ? { ...m, revenue_eur_minor: 2_000_000 } : m));
    // 2.0m of 8.0m = 25 % exactly
    expect(distribution(quarter, "average_order_value", "EUR").shown).toBe(true);
  });

  it("a money metric pools only the reader's currency, never converted", () => {
    const mixed = seven().map((m, i) =>
      i === 0
        ? {
            ...m,
            values: {
              average_order_value: { value: 9, numerator: 1, denominator: 1, currency: "HUF" },
            },
          }
        : m,
    );
    expect(distribution(mixed, "average_order_value", "EUR")).toEqual({ shown: false });
  });

  it("a metric SYB doesn't measure yet serves nothing, whatever the members say", () => {
    expect(distribution(seven(), "gross_margin", null)).toEqual({ shown: false });
  });
});

// ── Against the database: measured connector data ────────────────────────

const NOW = new Date("2026-11-12T09:00:00Z");
const MONTH = lastCompleteMonth(NOW); // 2026-10
const created: { account_id: string; profile_id: string }[] = [];

afterAll(async () => {
  const ids = created.map((s) => s.profile_id);
  const accountIds = created.map((s) => s.account_id);
  if (ids.length === 0) return;
  const conns = await db
    .select({ id: connections.id })
    .from(connections)
    .where(inArray(connections.account_id, accountIds));
  if (conns.length > 0) {
    await db.delete(metricObservations).where(
      inArray(
        metricObservations.connection_id,
        conns.map((c) => c.id),
      ),
    );
    await db.delete(connections).where(inArray(connections.account_id, accountIds));
  }
  await db.delete(peerBenchmarkConsents).where(inArray(peerBenchmarkConsents.profile_id, ids));
  await db.delete(intakeEvents).where(inArray(intakeEvents.profile_id, ids));
  await db.delete(fieldRecords).where(inArray(fieldRecords.profile_id, ids));
  await db.delete(businessProfiles).where(inArray(businessProfiles.id, ids));
  await db.delete(accounts).where(inArray(accounts.id, accountIds));
});

async function put(profileId: string, key: string, value: unknown): Promise<void> {
  const at = isoDateTime(new Date().toISOString());
  await writeField(
    profileId,
    createField<unknown>({
      id: fieldId(key),
      value,
      status: "answered",
      confidence: confidence(0.75),
      source: { kind: "owner_input" },
      observed_at: at,
      recorded_at: at,
    }),
  );
}

/**
 * A business placed by what the owner said (type, country, team), measured
 * by a connector for the whole of October unless `measured` is false — in
 * which case it only STATES its revenue and orders.
 */
async function business(opts: {
  country: string;
  dailyRevenueMinor: number;
  dailyOrders: number;
  team?: number;
  measured?: boolean;
  type?: string;
}) {
  const s = await bootstrapIntake();
  created.push(s);
  await put(s.profile_id, "identity.business_type", opts.type ?? "cafe");
  await put(s.profile_id, "legal.country", opts.country);
  if (opts.team) await put(s.profile_id, "identity.team_size", opts.team);
  if (opts.measured === false) {
    await put(s.profile_id, "revenue.monthly_revenue", money(opts.dailyRevenueMinor * 31, "EUR"));
    await put(s.profile_id, "revenue.order_count_monthly", opts.dailyOrders * 31);
    return s;
  }
  const [conn] = await db
    .insert(connections)
    .values({
      account_id: s.account_id,
      provider: "fixture",
      purpose: "measure",
      status: "connected",
      granted_scopes: ["read_revenue", "read_orders"],
    })
    .returning({ id: connections.id });
  const obs: Observation[] = [];
  for (let d = 1; d <= 31; d++) {
    const day = `${MONTH}-${String(d).padStart(2, "0")}`;
    const at = `${day}T23:00:00.000Z`;
    obs.push({
      metric_key: "revenue.daily",
      dimensions: { currency: "EUR" },
      value_minor: opts.dailyRevenueMinor,
      period_date: day,
      observed_at: at,
    });
    obs.push({
      metric_key: "orders.daily",
      dimensions: {},
      value_num: opts.dailyOrders,
      period_date: day,
      observed_at: at,
    });
  }
  await upsertObservations(conn!.id, "fixture", obs);
  return s;
}

/** A café in Portugal at ~€20k a month (≈ €240k a year: the 150k–500k band). */
const cafe = (dailyRevenueMinor = 64_516, team = 4) =>
  business({ country: "PT", dailyRevenueMinor, dailyOrders: 50, team });

const aov = async (profileId: string) =>
  (await peerBenchmarks(profileId, NOW)).find((b) => b.metric === "average_order_value")!;

describe("§5.7 — the acceptance criteria", { timeout: 120_000 }, () => {
  it("a cohort of 6 returns no data through every code path; the 7th opens it, recorded and sourced", async () => {
    const reader = await business({
      country: "ES",
      dailyRevenueMinor: 50_000,
      dailyOrders: 40,
      type: "bar",
    });
    // Six measured Portuguese cafés: the reader (a Spanish bar, NACE 56.30, Iberia) can reach them only by widening.
    const peers = [];
    for (let i = 0; i < 6; i++) peers.push(await cafe(60_000 + i * 1_000));
    expect((await aov(reader.profile_id)).status).toBe("not_enough");
    expect(await peerAverageOrderValue(reader.profile_id, NOW)).toEqual({
      shown: false,
      fallback: "eurostat",
    });
    for (const rung of cohortLadder({ nace: "56.30", country: "ES", band: "150k_500k" })) {
      for (const metric of ["average_order_value", "revenue_per_employee"] as const) {
        expect(
          await cohortQuery({
            spec: rung.spec,
            metric,
            month: MONTH,
            readerProfileId: reader.profile_id,
            readerCurrency: "EUR",
          }),
        ).toEqual({ shown: false });
      }
    }

    peers.push(await cafe(66_000));
    const served = await aov(reader.profile_id);
    expect(served).toMatchObject({
      status: "served",
      currency: "EUR",
      source: "syb_peer_cohort",
      as_of: "2026-10-31",
      cohort: {
        businesses: 7,
        month: "2026-10",
        geography: { kind: "region", id: "Iberia" },
        widened: ["nace_3", "nace_2", "region"],
      },
      own: { basis: "measured" },
    });
    if (served.status === "served") {
      expect(served.p25).toBeLessThanOrEqual(served.p50);
      expect(served.p50).toBeLessThanOrEqual(served.p75);
    }
    // Every peer's serving names the same rung for the same inputs.
    expect(await aov(reader.profile_id)).toEqual(served);
  });

  // Ireland is in no region group, so these cohorts never widen into another test's businesses.
  const irishMeasured: string[] = [];
  const restaurant = async (daily: number, measured = true) => {
    const s = await business({
      country: "IE",
      dailyRevenueMinor: daily,
      dailyOrders: 30,
      type: "restaurant",
      measured,
    });
    if (measured) irishMeasured.push(s.profile_id);
    return s;
  };

  it("an owner-stated figure never enters a cohort aggregate", async () => {
    const reader = await restaurant(50_000);
    // Five more measured restaurants (six with the reader) and ten that only STATED their numbers.
    for (let i = 0; i < 5; i++) await restaurant(60_000 + i * 500);
    for (let i = 0; i < 10; i++) await restaurant(60_000, false);
    expect((await aov(reader.profile_id)).status).toBe("not_enough");
    // Two more measured open it — and the cohort counts only the measured.
    await restaurant(63_000);
    await restaurant(61_000);
    const served = await aov(reader.profile_id);
    expect(served.status === "served" && served.cohort.businesses).toBe(7);
  });

  it("an owner-stated reader is compared against the cohort, and says so", async () => {
    const stated = await restaurant(40_000, false);
    const served = await aov(stated.profile_id);
    expect(served.status === "served" && served.own?.basis).toBe("stated");
    expect(served.status === "served" && served.cohort.businesses).toBe(8);
  });

  it("opting out removes the business from the very next aggregate", async () => {
    const reader = await business({
      country: "IE",
      dailyRevenueMinor: 55_000,
      dailyOrders: 30,
      type: "restaurant",
    });
    expect((await aov(reader.profile_id)).status).toBe("served"); // eight measured others
    await optOutOfPeers({ profileId: irishMeasured[0]!, by: null });
    await optOutOfPeers({ profileId: irishMeasured[1]!, by: null });
    const after = await aov(reader.profile_id);
    expect(after.status).toBe("not_enough"); // six left
    // One that opted out still reads its benchmark: the six still in, plus the new reader (§5.5).
    const optedOut = await aov(irishMeasured[0]!);
    expect(optedOut.status === "served" && optedOut.cohort.businesses).toBe(7);
  });
});

describe("§5.2 — the extraction attack", { timeout: 120_000 }, () => {
  it("narrowing the cohort every way the query layer allows never isolates one business's revenue", async () => {
    // Seven cafés in Luxembourg at ≈ €20k a month, and the target at ≈ €60k:
    // alone in its revenue band, and 30 % of the revenue of all eight.
    const target = await business({
      country: "LU",
      dailyRevenueMinor: 193_548,
      dailyOrders: 90,
      team: 7,
    });
    const attacker = await business({
      country: "LU",
      dailyRevenueMinor: 64_516,
      dailyOrders: 50,
      team: 3,
    });
    for (let i = 0; i < 6; i++)
      await business({
        country: "LU",
        dailyRevenueMinor: 64_516 + i * 100,
        dailyOrders: 50,
        team: 4,
      });
    const targetMonthly = 193_548 * 31;

    const results: unknown[] = [];
    for (const nace of ["56.30", "56.3", "56"] as const) {
      const level = nace === "56.30" ? 4 : nace === "56.3" ? 3 : 2;
      const geographies: CohortSpec["geography"][] = [
        { kind: "country", code: "LU" },
        { kind: "region", id: "Benelux", countries: ["BE", "NL", "LU"] },
      ];
      for (const geography of geographies) {
        for (const band of [...BAND_IDS, "any"]) {
          for (const metric of ["average_order_value", "revenue_per_employee"] as const) {
            const d = await cohortQuery({
              spec: { nace, nace_level: level, geography, band },
              metric,
              month: MONTH,
              readerProfileId: attacker.profile_id,
              readerCurrency: "EUR",
            });
            results.push(d);
            // Whatever is served, it is at least seven businesses — never one, never "a few".
            if (d.shown) expect(d.businesses).toBeGreaterThanOrEqual(7);
            // The target's own band holds only the target: nothing.
            if (band === "500k_1_5m") expect(d).toEqual({ shown: false });
          }
        }
      }
    }
    // Every cohort that contains the target is dominated by it, so none is
    // served: no pair of answers differs by the target alone.
    expect(results.every((r) => (r as { shown: boolean }).shown === false)).toBe(true);
    // And the target's revenue appears in no answer, in any form.
    const text = JSON.stringify(results);
    expect(text).not.toContain(String(targetMonthly));
    expect(text).not.toContain(String(Math.round(targetMonthly / 7)));
    void target;
  });
});
