// Review 2026-10-30 — the track record's read is bounded: the counts are SQL
// over every forecast of the business, and only the newest TRACK_LISTED are
// listed, with a line saying how many older ones aren't.

import "dotenv/config";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../../db";
import { accounts, businessProfiles, forecastChecks } from "../../db/schema";
import { trackRecord } from "./load";
import { TRACK_LISTED } from "./view";

let accountId: string;
let profileId: string;
const NOW = new Date("2026-11-20T08:00:00Z");

beforeAll(async () => {
  const [a] = await db.insert(accounts).values({ reporting_currency: "EUR" }).returning();
  accountId = a!.id;
  const [p] = await db
    .insert(businessProfiles)
    .values({ account_id: accountId, schema_version: "1.0.0" })
    .returning();
  profileId = p!.id;
});

afterAll(async () => {
  // The forecasts go with the business (migration 0067's cascade).
  await db.delete(businessProfiles).where(eq(businessProfiles.id, profileId));
  await db.delete(accounts).where(eq(accounts.id, accountId));
});

async function record(total: number): Promise<string[]> {
  const rows = Array.from({ length: total }, (_, i) => ({
    account_id: accountId,
    profile_id: profileId,
    kind: "stock_out",
    forecast_key: `test|${i}`,
    // One a day going back: index 0 is the newest.
    made_at: new Date(NOW.getTime() - (i + 10) * 86_400_000).toISOString(),
    subject: `Item ${i}`,
    subject_ref: {},
    metric: "stock.on_hand",
    unit: "date",
    window_start: "2026-10-01",
    window_end: "2026-10-07",
    low_date: "2026-10-03",
    high_date: "2026-10-05",
    claim: `Item ${i} runs out between 3 and 5 Oct.`,
    basis: "test",
  }));
  const ids = await db
    .insert(forecastChecks)
    .values(rows)
    .returning({ id: forecastChecks.id, key: forecastChecks.forecast_key });
  return ids
    .sort((a, b) => Number(a.key.split("|")[1]) - Number(b.key.split("|")[1]))
    .map((r) => r.id);
}

describe("the track record, bounded", () => {
  it("counts every forecast but lists only the newest, and says how many aren't listed", async () => {
    const ids = await record(TRACK_LISTED + 3);
    // The three oldest graded, so the headline counts rows the list doesn't carry.
    const oldest = ids.slice(-3);
    await db
      .update(forecastChecks)
      .set({
        graded_at: NOW.toISOString(),
        verdict: "inside",
        actual_note: "It ran out on 4 Oct: inside the range.",
        actual_source: { table: "metric_observations", ids: [] },
      })
      .where(inArray(forecastChecks.id, oldest));

    const v = await trackRecord(profileId, NOW);
    expect(v.entries).toHaveLength(TRACK_LISTED);
    expect(v.entries[0]!.id).toBe(ids[0]);
    expect(v.entries.some((e) => oldest.includes(e.id))).toBe(false);
    expect(v).toMatchObject({ graded: 3, inside: 3, waiting: TRACK_LISTED, older: 3 });
    expect(v.headline).toBe("3 of my last 3 forecasts landed inside the range I gave; 0 missed.");
    expect(v.older_line).toBe(
      "3 older forecasts aren't listed here; the counts above include them.",
    );
    expect(v.kinds[0]?.sentence).toBe(
      `Stock run-out dates: 3 of 3 inside, ${TRACK_LISTED} waiting.`,
    );
  });
});
