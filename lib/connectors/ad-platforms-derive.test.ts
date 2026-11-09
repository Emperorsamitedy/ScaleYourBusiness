// Review 2026-11-08 (ads and posting): the business-wide ad facts are the
// business's across Meta, Google Ads and TikTok Ads — never whichever
// platform synced last. Database-backed; no network.

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
import { readCurrentField } from "../profile/field-store";
import { deriveFactsFromObservations } from "./derive";

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

async function business() {
  const s = await bootstrapIntake();
  created.push(s);
  return s;
}

const day = (offset: number) =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

async function connection(
  accountId: string,
  provider: string,
  purpose: "measure" | "execute",
): Promise<string> {
  const [row] = await db
    .insert(connections)
    .values({ account_id: accountId, provider, purpose })
    .returning({ id: connections.id });
  return row!.id;
}

/** Three days of business-wide spend, and purchases when given. */
async function series(
  connId: string,
  provider: string,
  currency: string,
  spendMinor: number,
  purchases: number | null,
) {
  const rows = [];
  for (let i = 1; i <= 3; i++) {
    rows.push({
      connection_id: connId,
      provider,
      metric_key: "ad_spend.daily",
      dimensions: { currency },
      dimension_key: JSON.stringify({ currency }),
      period_date: day(-i),
      value_minor: spendMinor,
      currency,
      observed_at: new Date().toISOString(),
    });
    if (purchases !== null) {
      rows.push({
        connection_id: connId,
        provider,
        metric_key: "ad_purchases.daily",
        dimensions: {},
        dimension_key: JSON.stringify({}),
        period_date: day(-i),
        value_num: String(purchases),
        observed_at: new Date().toISOString(),
      });
    }
  }
  await db.insert(metricObservations).values(rows);
}

describe("ad facts across Meta, Google Ads and TikTok Ads", () => {
  it("monthly ad spend adds all three platforms, naming every series", async () => {
    const s = await business();
    const meta = await connection(s.account_id, "meta_ads", "measure");
    const google = await connection(s.account_id, "google_ads", "execute");
    const tiktok = await connection(s.account_id, "tiktok_ads", "execute");
    await series(meta, "meta_ads", "EUR", 1000, 2);
    await series(google, "google_ads", "EUR", 500, null);
    await series(tiktok, "tiktok_ads", "EUR", 300, 1);
    // Whatever order they sync in, the last one writes the sum.
    for (const id of [meta, google, tiktok]) await deriveFactsFromObservations(id);
    const fact = await readCurrentField<unknown>(s.profile_id, "marketing.monthly_ad_spend");
    expect(fact?.value).toEqual({ amount_minor: 3 * (1000 + 500 + 300), currency: "EUR" });
    const source = JSON.stringify(fact?.source);
    for (const p of ["meta_ads", "google_ads", "tiktok_ads"]) {
      expect(source).toContain(`connector:${p}:ad_spend.daily`);
    }
  });

  it("monthly ad spend refuses TikTok in another currency, never a blend", async () => {
    const s = await business();
    const meta = await connection(s.account_id, "meta_ads", "measure");
    const tiktok = await connection(s.account_id, "tiktok_ads", "execute");
    await series(meta, "meta_ads", "EUR", 1000, 2);
    await series(tiktok, "tiktok_ads", "HUF", 300_00, 1);
    const out = await deriveFactsFromObservations(tiktok);
    expect(out.find((o) => o.field_key === "marketing.monthly_ad_spend")).toMatchObject({
      outcome: "refused",
      reason: expect.stringMatching(/currencies never blend/),
    });
  });

  it("cost per purchase is Meta's and TikTok's together, and doesn't flip with the sync order", async () => {
    const s = await business();
    const meta = await connection(s.account_id, "meta_ads", "measure");
    const google = await connection(s.account_id, "google_ads", "execute");
    const tiktok = await connection(s.account_id, "tiktok_ads", "execute");
    await series(meta, "meta_ads", "EUR", 1000, 2); // 30.00 over 6 purchases
    await series(google, "google_ads", "EUR", 500, null); // no purchases: out of both sides
    await series(tiktok, "tiktok_ads", "EUR", 600, 3); // 18.00 over 9 purchases
    const expected = { amount_minor: Math.round((3000 + 1800) / 15), currency: "EUR" };

    await deriveFactsFromObservations(meta);
    const afterMeta = await readCurrentField<unknown>(s.profile_id, "marketing.cost_per_purchase");
    await deriveFactsFromObservations(tiktok);
    const afterTikTok = await readCurrentField<unknown>(
      s.profile_id,
      "marketing.cost_per_purchase",
    );
    expect(afterMeta?.value).toEqual(expected);
    expect(afterTikTok?.value).toEqual(expected);
    const source = JSON.stringify(afterTikTok?.source);
    expect(source).toContain("connector:meta_ads:ad_purchases.daily");
    expect(source).toContain("connector:tiktok_ads:ad_purchases.daily");
    expect(source).not.toContain("connector:google_ads");

    // A second night in the other order writes nothing new.
    const again = await deriveFactsFromObservations(meta);
    expect(again.find((o) => o.field_key === "marketing.cost_per_purchase")?.outcome).toBe(
      "unchanged",
    );
  });
});
