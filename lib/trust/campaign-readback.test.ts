// Review 2026-11-08: an executed Google Ads or TikTok Ads change is judged on
// ITS platform's campaign series, never looked up in Meta's — where the same
// id may be another campaign entirely. Database-backed; no network.

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
} from "../../db/schema";
import { bootstrapIntake } from "../intake/service";
import { adPlatformOf, campaignOutcome } from "./campaign-readback";
import { shiftDay } from "./series";

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
  }
  await db.delete(connections).where(inArray(connections.account_id, accountIds));
  await db.delete(intakeEvents).where(inArray(intakeEvents.profile_id, ids));
  await db.delete(fieldRecords).where(inArray(fieldRecords.profile_id, ids));
  await db.delete(businessProfiles).where(inArray(businessProfiles.id, ids));
  await db.delete(accounts).where(inArray(accounts.id, accountIds));
});

const NOW = new Date();
const today = NOW.toISOString().slice(0, 10);
const CHANGED = shiftDay(today, -20);
const REF = "1800000000000001";

/** Ten spending days before the change, then covered days of no spend (a pause that held). */
async function seed(
  accountId: string,
  provider: string,
  purpose: "measure" | "execute",
  value: number,
) {
  const [conn] = await db
    .insert(connections)
    .values({ account_id: accountId, provider, purpose })
    .returning({ id: connections.id });
  const rows = [];
  const dims = { currency: "EUR", campaign_ref: REF, campaign_name: "Autumn" };
  for (let i = 1; i <= 10; i++) {
    const d = shiftDay(CHANGED, -i);
    for (const [metric_key, v] of [
      ["ad_spend.campaign.daily", 1000],
      ["ad_purchase_value.campaign.daily", value],
    ] as const) {
      rows.push({
        connection_id: conn!.id,
        provider,
        metric_key,
        dimensions: dims,
        dimension_key: JSON.stringify(dims),
        period_date: d,
        value_minor: v,
        currency: "EUR",
        observed_at: NOW.toISOString(),
      });
    }
  }
  for (let i = 1; i <= 15; i++) {
    rows.push({
      connection_id: conn!.id,
      provider,
      metric_key: "ad_spend.daily",
      dimensions: { currency: "EUR" },
      dimension_key: JSON.stringify({ currency: "EUR" }),
      period_date: shiftDay(CHANGED, i),
      value_minor: 0,
      currency: "EUR",
      observed_at: NOW.toISOString(),
    });
  }
  await db.insert(metricObservations).values(rows);
}

describe("campaign readback per platform", () => {
  it("judges a TikTok pause on TikTok's series, a Meta one on Meta's — same campaign id", async () => {
    const s = await bootstrapIntake();
    created.push(s);
    await seed(s.account_id, "meta_ads", "measure", 2000); // ROAS 2.00: pausing it backfired
    await seed(s.account_id, "tiktok_ads", "execute", 500); // ROAS 0.50: pausing it helped
    const base = {
      accountId: s.account_id,
      campaignRef: REF,
      campaignName: "Autumn",
      changedOn: CHANGED,
      now: NOW,
    };
    const tiktok = await campaignOutcome({ ...base, platform: "tiktok" });
    expect(tiktok.verdict).toBe("helped");
    expect(tiktok.delta_pct).toBe(50);
    expect(tiktok.arithmetic).toContain("TikTok attributes");
    expect(tiktok.arithmetic).not.toContain("Meta");
    const meta = await campaignOutcome(base);
    expect(meta.verdict).toBe("backfired");
    expect(meta.arithmetic).toContain("Meta attributes");
  });

  it("a Google change with no Google read connection is unmeasured, never Meta's numbers", async () => {
    const s = await bootstrapIntake();
    created.push(s);
    await seed(s.account_id, "meta_ads", "measure", 2000);
    const google = await campaignOutcome({
      accountId: s.account_id,
      campaignRef: REF,
      campaignName: "Autumn",
      changedOn: CHANGED,
      now: NOW,
      platform: "google",
    });
    expect(google.verdict).toBe("unmeasured");
    expect(google.arithmetic).toMatch(/no Google ads read connection/);
  });

  it("reads a proposal's platform, Meta when absent", () => {
    expect(adPlatformOf("google")).toBe("google");
    expect(adPlatformOf("tiktok")).toBe("tiktok");
    expect(adPlatformOf(undefined)).toBe("meta");
    expect(adPlatformOf("myspace")).toBe("meta");
  });
});
