// The chart loader against a real database: a salon's bookings import,
// a business with nothing connected, two sources measuring the same sales
// (never summed), sliced rows (never business-wide), a second currency
// (never blended), and the waiting proposals' scenarios. No network.

import "dotenv/config";
import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../../db";
import {
  accounts,
  anomalies,
  bookingAppointments,
  bookingImports,
  businessProfiles,
  connections,
  connectorSyncs,
  fieldRecords,
  metricObservations,
  profileSnapshots,
  proposals,
  watchActivity,
} from "../../db/schema";
import { ADS } from "../ads/proposals";
import { shiftDay } from "../anomaly/baseline";
import { CAPACITY_KEY, importBookings } from "../bookings/store";
import { canonicalDimensions } from "../connectors/service";
import { createField } from "../core/field";
import { fieldId } from "../core/ids";
import { isoDateTime } from "../core/iso";
import { bootstrapIntake } from "../intake/service";
import { writeField } from "../profile/field-store";
import { loadCharts } from "./load";
import { OPPORTUNITY } from "./opportunity";

const NOW = new Date("2026-10-22T09:00:00Z");
const TODAY = "2026-10-22";
const created: { account_id: string; profile_id: string }[] = [];

beforeEach(() => {
  vi.stubGlobal("fetch", () => {
    throw new Error("the real network was called");
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  for (const s of created) {
    await db.delete(anomalies).where(eq(anomalies.profile_id, s.profile_id));
    await db.delete(watchActivity).where(eq(watchActivity.profile_id, s.profile_id));
    await db.delete(proposals).where(eq(proposals.profile_id, s.profile_id));
    const rows = await db
      .select({ id: connections.id })
      .from(connections)
      .where(eq(connections.account_id, s.account_id));
    const ids = rows.map((r) => r.id);
    if (ids.length > 0) {
      await db.delete(bookingAppointments).where(inArray(bookingAppointments.connection_id, ids));
      await db.delete(bookingImports).where(inArray(bookingImports.connection_id, ids));
      await db.delete(metricObservations).where(inArray(metricObservations.connection_id, ids));
      await db.delete(connectorSyncs).where(inArray(connectorSyncs.connection_id, ids));
    }
    await db.delete(connections).where(eq(connections.account_id, s.account_id));
    await db.delete(profileSnapshots).where(eq(profileSnapshots.profile_id, s.profile_id));
    await db.delete(fieldRecords).where(eq(fieldRecords.profile_id, s.profile_id));
    await db.delete(businessProfiles).where(eq(businessProfiles.id, s.profile_id));
    await db.delete(accounts).where(eq(accounts.id, s.account_id));
  }
});

async function scenario(businessType: string | null) {
  const s = await bootstrapIntake();
  created.push(s);
  if (businessType) await ownerSays(s.profile_id, "identity.business_type", { code: businessType });
  return s;
}

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

/** 56 days of a salon to yesterday: six appointments a day at €45, a no-show every 5th. */
function salonCsv(): string {
  const lines = ["Date,Time,Status,Service,Email,Price"];
  for (let d = 56; d >= 1; d--) {
    const day = shiftDay(TODAY, -d);
    for (let k = 0; k < 6; k++) {
      const n = d * 6 + k;
      const status = n % 5 === 0 ? "No-show" : n % 17 === 0 ? "Late cancel" : "Completed";
      lines.push(
        `${day},${String(9 + k).padStart(2, "0")}:00,${status},Cut,c${n % 9}@example.com,45.00`,
      );
    }
  }
  return lines.join("\n");
}

async function fixtureConnection(accountId: string, provider: string): Promise<string> {
  const [row] = await db
    .insert(connections)
    .values({ account_id: accountId, provider, purpose: "measure", status: "connected" })
    .returning({ id: connections.id });
  return row!.id;
}

async function observe(
  connectionId: string,
  provider: string,
  metric: string,
  days: number,
  value: (i: number) => { minor?: number; num?: number; currency?: string },
  dims: Record<string, string> = {},
) {
  const rows = Array.from({ length: days }, (_, i) => {
    const v = value(i);
    const dimensions = { ...dims, ...(v.currency ? { currency: v.currency } : {}) };
    return {
      connection_id: connectionId,
      provider,
      metric_key: metric,
      dimensions,
      dimension_key: canonicalDimensions(dimensions),
      period_date: shiftDay(TODAY, -(days - i)),
      value_minor: v.minor ?? null,
      currency: v.currency ?? null,
      value_num: v.num === undefined ? null : String(v.num),
      observed_at: NOW.toISOString(),
    };
  });
  await db.insert(metricObservations).values(rows);
}

describe("loadCharts — a salon's bookings import", () => {
  it("draws booking revenue a day with appointments as the volume, and prices the no-shows", async () => {
    const s = await scenario("salon_beauty");
    await ownerSays(s.profile_id, CAPACITY_KEY, 40);
    await importBookings(
      s.account_id,
      salonCsv(),
      { platform: "generic", currency: "EUR", dateOrder: null },
      NOW,
    );
    // The import source was created by the database clock; the test reads as of NOW.
    await db
      .update(connections)
      .set({ created_at: "2026-09-01T08:00:00Z" })
      .where(eq(connections.account_id, s.account_id));
    const { market, bookings, ads } = await loadCharts(s.account_id, s.profile_id, NOW);
    expect(market.status).toBe("drawn");
    if (market.status !== "drawn") return;
    expect(market.title).toBe("Your salon, read like a stock");
    expect(market.price).toMatchObject({
      metric: "booking_revenue.daily",
      source: "your bookings export",
      basis: "OBSERVED",
    });
    expect(market.volume?.word).toBe("appointments");
    expect(market.currency).toBe("EUR");
    const noShows = market.components.find((c) => c.key === "no_shows");
    expect(noShows?.status).toBe("priced");
    if (noShows?.status === "priced") {
      // Every completed appointment is €45, so the price range is a point.
      expect(noShows.total.low_minor % 4500).toBe(0);
      expect(noShows.total.low_minor).toBe(noShows.total.high_minor);
      expect(noShows.total.low_minor).toBeGreaterThan(0);
    }
    const capacity = market.components.find((c) => c.key === "empty_capacity");
    expect(capacity?.status === "priced" && capacity.basis_note).toMatch(/STATED \(40 a week\)/);
    expect(market.headline.text).toMatch(/a month is slipping away/);
    expect(market.events).toContainEqual(
      expect.objectContaining({
        date: "2026-09-01",
        kind: "connected",
        label: "Bookings first imported",
      }),
    );
    // The small bookings chart exists; the ads chart doesn't (no Meta).
    expect(bookings?.weeks.length).toBeGreaterThan(5);
    expect(bookings?.totals.no_show).toBeGreaterThan(0);
    expect(ads).toBeNull();
  });
});

describe("loadCharts — TikTok Ads as the only ad source", () => {
  it("draws its campaigns as TikTok's, from its execute connection's read", async () => {
    const s = await scenario("ecommerce_store");
    const [conn] = await db
      .insert(connections)
      .values({ account_id: s.account_id, provider: "tiktok_ads", purpose: "execute" })
      .returning({ id: connections.id });
    const dims = { campaign_ref: "1800000000000000001", campaign_name: "Autumn" };
    await observe(
      conn!.id,
      "tiktok_ads",
      "ad_spend.campaign.daily",
      20,
      () => ({
        minor: 2000,
        currency: "EUR",
      }),
      dims,
    );
    await observe(
      conn!.id,
      "tiktok_ads",
      "ad_purchase_value.campaign.daily",
      20,
      () => ({
        minor: 1000,
        currency: "EUR",
      }),
      dims,
    );
    const { ads } = await loadCharts(s.account_id, s.profile_id, NOW);
    expect(ads).not.toBeNull();
    expect(ads!.platforms).toEqual(["tiktok"]);
    expect(ads!.campaigns).toMatchObject([
      { platform: "tiktok", campaign_ref: "1800000000000000001", losing: true },
    ]);
    expect(ads!.summary).toContain("Autumn on TikTok Ads spent");
    expect(ads!.summary).not.toMatch(/Meta/);
  });
});

describe("loadCharts — a business with no data", () => {
  it("is the honest empty state, inviting the shop's connection", async () => {
    const s = await scenario("ecommerce_store");
    const { market, bookings, ads } = await loadCharts(s.account_id, s.profile_id, NOW);
    expect(market.status).toBe("empty");
    if (market.status !== "empty") return;
    expect(market.title).toBe("Your shop, read like a stock");
    expect(market.message).toMatch(/^Connect Shopify or WooCommerce/);
    expect(market.components.every((c) => c.status === "absent")).toBe(true);
    expect(bookings).toBeNull();
    expect(ads).toBeNull();
  });

  it("with no business type, says 'your business' and tries everything", async () => {
    const s = await scenario(null);
    const { market } = await loadCharts(s.account_id, s.profile_id, NOW);
    expect(market.title).toBe("Your business, read like a stock");
    expect(market.status === "empty" && market.message).toMatch(/import your bookings/);
  });
});

describe("loadCharts — series rules", () => {
  it("reads ONE source's revenue, business-wide rows only, one currency", async () => {
    const s = await scenario("retail_shop");
    const a = await fixtureConnection(s.account_id, "fixture");
    const b = await fixtureConnection(s.account_id, "stripe");
    await observe(a, "fixture", "revenue.daily", 40, () => ({ minor: 10000, currency: "EUR" }));
    // The same sales seen by a second source: fewer days, never added.
    await observe(b, "stripe", "revenue.daily", 20, () => ({ minor: 10000, currency: "EUR" }));
    // A sliced row (per product) is not business-wide.
    await observe(a, "fixture", "revenue.daily", 40, () => ({ minor: 77700, currency: "EUR" }), {
      product_ref: "p1",
    });
    // A second currency on the same source: not drawn, said so.
    await observe(a, "fixture", "revenue.daily", 30, () => ({ minor: 5000, currency: "GBP" }));
    await observe(a, "fixture", "orders.daily", 40, () => ({ num: 4 }));
    const { market } = await loadCharts(s.account_id, s.profile_id, NOW);
    expect(market.status).toBe("drawn");
    if (market.status !== "drawn") return;
    expect(market.price.source).toBe("Fixture");
    expect(market.currency).toBe("EUR");
    expect(new Set(market.days.map((d) => d.value_minor))).toEqual(new Set([10000]));
    expect(market.days).toHaveLength(40);
    expect(market.days.every((d) => d.volume === 4)).toBe(true);
    expect(market.notes.join(" ")).toMatch(/GBP isn't drawn/);
  });

  it("puts the waiting proposals' cases on the table, and ignores an expired one", async () => {
    const s = await scenario("retail_shop");
    const a = await fixtureConnection(s.account_id, "fixture");
    await observe(a, "fixture", "revenue.daily", 30, () => ({ minor: 20000, currency: "EUR" }));
    const scenarioOf = (base: number, upside: number) => ({
      assumptions: [],
      base_case: {
        case: "base",
        statement: "s",
        formula: null,
        profit_delta_monthly: { amount_minor: base, currency: "EUR" },
      },
      downside_case: {
        case: "downside",
        statement: "s",
        formula: null,
        profit_delta_monthly: null,
      },
      upside_case: {
        case: "upside",
        statement: "s",
        formula: null,
        profit_delta_monthly: { amount_minor: upside, currency: "EUR" },
      },
      breakeven_condition: "",
    });
    const common = {
      profile_id: s.profile_id,
      module: "diagnosis",
      reversibility: { level: "easy", if_you_change_your_mind: "undo it" },
    };
    await db.insert(proposals).values([
      {
        ...common,
        action: { kind: "price_increase", summary: "Raise the mug price" },
        scenario: scenarioOf(80000, 120000),
        expires_at: new Date(NOW.getTime() + 7 * 86_400_000).toISOString(),
      },
      {
        ...common,
        action: { kind: "price_increase", summary: "An old idea" },
        scenario: scenarioOf(999900, 999900),
        expires_at: new Date(NOW.getTime() - 86_400_000).toISOString(),
      },
    ]);
    const { market } = await loadCharts(s.account_id, s.profile_id, NOW);
    const table =
      market.status === "drawn" ? market.components.find((c) => c.key === "on_the_table") : null;
    expect(table?.status).toBe("priced");
    if (table?.status === "priced") {
      expect(table.total).toEqual({ low_minor: 80000, high_minor: 120000, currency: "EUR" });
      expect(table.basis).toBe("ESTIMATED");
    }
  });
});

describe("the ads window", () => {
  it("is the pause rule's own window and line", () => {
    expect(OPPORTUNITY.ads_window_days).toBe(ADS.pause_window_days);
    expect(OPPORTUNITY.losing_roas_below).toBe(ADS.pause_roas_below);
  });
});
