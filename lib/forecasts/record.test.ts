// I-54c — one run-out counts once on the track record, against live Postgres.
// What must hold: while an item's stock-out claim waits for its grade, a later
// week's claim for the same item isn't recorded; another item's is; once the
// first is graded, the item's next one is; the same week's claim stays a no-op.

import "dotenv/config";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../../db";
import { accounts, businessProfiles, forecastChecks } from "../../db/schema";
import type { ForecastClaim } from "./claims";
import { recordForecasts, runOutItem } from "./record";

let accountId: string;
let profileId: string;

beforeAll(async () => {
  const [account] = await db.insert(accounts).values({ reporting_currency: "EUR" }).returning();
  accountId = account!.id;
  const [profile] = await db
    .insert(businessProfiles)
    .values({ account_id: accountId, schema_version: "1.0.0" })
    .returning();
  profileId = profile!.id;
});

afterAll(async () => {
  await db.delete(businessProfiles).where(eq(businessProfiles.id, profileId));
  await db.delete(accounts).where(eq(accounts.id, accountId));
});

const warning = (item: string, week: string): ForecastClaim => ({
  account_id: accountId,
  profile_id: profileId,
  kind: "stock_out",
  forecast_key: `stock_out|${item}|${week}`,
  made_at: "2026-10-26T09:00:00.000Z",
  subject: item,
  subject_ref: { connection_id: "c", product_ref: item, as_of: "2026-10-26", on_hand: 4 },
  metric: "stock.on_hand",
  unit: "date",
  window_start: "2026-10-26",
  window_end: "2026-11-01",
  low_date: "2026-10-30",
  high_date: "2026-11-01",
  claim: "Runs out in about 4–6 days.",
  basis: "test",
});

const keysOf = async () =>
  (
    await db
      .select({ key: forecastChecks.forecast_key })
      .from(forecastChecks)
      .where(and(eq(forecastChecks.profile_id, profileId), eq(forecastChecks.kind, "stock_out")))
  )
    .map((r) => r.key)
    .sort();

describe("I-54c — one run-out counts once", () => {
  it("names the item of a stock-out key, and nothing else", () => {
    expect(runOutItem("stock_out|c|gid://x/1|2026-W44")).toBe("stock_out|c|gid://x/1");
    expect(runOutItem("season_week|c|revenue.daily|EUR|2026-11-02")).toBeNull();
  });

  it("a waiting item isn't recorded again; another item is; once graded, the next one is", async () => {
    expect(await recordForecasts([warning("mug", "2026-W44")])).toBe(1);
    // Next week, the mug is still waiting: not again. The bowl is new.
    expect(await recordForecasts([warning("mug", "2026-W45"), warning("bowl", "2026-W45")])).toBe(
      1,
    );
    // The same week's claim again is a no-op, as before.
    expect(await recordForecasts([warning("mug", "2026-W44")])).toBe(0);
    expect(await keysOf()).toEqual(["stock_out|bowl|2026-W45", "stock_out|mug|2026-W44"]);

    // The mug's claim is graded: its next warning is a new forecast.
    await db
      .update(forecastChecks)
      .set({
        graded_at: "2026-11-03T06:00:00.000Z",
        verdict: "inside",
        actual_num: "0",
        actual_date: "2026-10-31",
        actual_note: "It ran out inside the days I gave.",
        actual_source: { table: "metric_observations", ids: ["x"] },
      })
      .where(eq(forecastChecks.forecast_key, "stock_out|mug|2026-W44"));
    expect(await recordForecasts([warning("mug", "2026-W46")])).toBe(1);
    expect(await keysOf()).toContain("stock_out|mug|2026-W46");
  });
});
