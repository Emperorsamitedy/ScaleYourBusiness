// I-54.2 + I-54.3 — recorded as shown, graded once on the weekly beat,
// against live Postgres and measured rows only. No model, no network.
//   · the season's coming weeks, read by the real loader, are recorded the
//     first time they are shown and never twice;
//   · a closed week is graded from the same source's measured days; a week
//     still missing a day waits; a graded claim isn't graded again;
//   · a stock-out claim is graded from the item's later counts.

import "dotenv/config";
process.env.CONNECTOR_KEY ??= "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../../db";
import {
  accounts,
  businessProfiles,
  connections,
  forecastChecks,
  metricObservations,
} from "../../db/schema";
import type { Observation } from "../connectors/provider";
import { upsertObservations } from "../connectors/service";
import { addDays } from "../seasons/forecast";
import { loadSeasons } from "../seasons/load";
import { seasonClaims } from "./claims";
import { recordForecasts } from "./record";
import { runForecastGrading } from "./run";

const TODAY = "2026-10-28"; // a Wednesday
const NOW = new Date(`${TODAY}T08:00:00Z`);
const PER_DAY = 50_000; // €500 a day, every day

let accountId: string;
let profileId: string;
let connectionId: string;

const revenue = (day: string, minor: number): Observation => ({
  metric_key: "revenue.daily",
  period_date: day,
  dimensions: { currency: "EUR" },
  value_minor: minor,
  observed_at: NOW.toISOString(),
});

beforeAll(async () => {
  const [a] = await db.insert(accounts).values({ reporting_currency: "EUR" }).returning();
  accountId = a!.id;
  const [p] = await db
    .insert(businessProfiles)
    .values({ account_id: accountId, schema_version: "1.0.0" })
    .returning();
  profileId = p!.id;
  const [c] = await db
    .insert(connections)
    .values({ account_id: accountId, provider: "shopify" })
    .returning({ id: connections.id });
  connectionId = c!.id;
  // 420 days of a steady €500 a day, to yesterday: a year and more of weeks.
  const obs: Observation[] = [];
  for (let i = 1; i <= 420; i++) obs.push(revenue(addDays(TODAY, -i), PER_DAY));
  await upsertObservations(connectionId, "shopify", obs);
});

afterAll(async () => {
  await db.delete(metricObservations).where(eq(metricObservations.connection_id, connectionId));
  await db.delete(connections).where(eq(connections.id, connectionId));
  // The forecasts go with the business (migration 0067's cascade).
  await db.delete(businessProfiles).where(eq(businessProfiles.id, profileId));
  await db.delete(accounts).where(eq(accounts.id, accountId));
});

const claimsOf = () =>
  db.select().from(forecastChecks).where(eq(forecastChecks.profile_id, profileId));

describe("the season's weeks, recorded as shown and graded once", () => {
  it("records the coming weeks the first time they are shown, never twice", async () => {
    const view = await loadSeasons(accountId, profileId, NOW);
    expect(view.result.status).toBe("ready");
    expect(view.series_ref).toEqual({ connection_id: connectionId, metric: "revenue.daily" });
    const claims = seasonClaims({ account_id: accountId, profile_id: profileId }, view, NOW);
    // This week is under way: the seven after it.
    expect(claims.map((c) => c.window_start)).toEqual(
      Array.from({ length: 7 }, (_, k) => addDays("2026-11-02", 7 * k)),
    );
    expect(await recordForecasts(claims)).toBe(7);
    // Shown again, a day later: the same weeks, nothing new.
    const later = new Date(NOW.getTime() + 86_400_000);
    const again = seasonClaims(
      { account_id: accountId, profile_id: profileId },
      await loadSeasons(accountId, profileId, later),
      later,
    );
    expect(await recordForecasts(again)).toBe(0);
    const [first] = (await claimsOf()).filter((c) => c.window_start === "2026-11-02");
    expect(first).toMatchObject({
      low_minor: 7 * PER_DAY,
      high_minor: 7 * PER_DAY,
      currency: "EUR",
    });
    expect(Date.parse(first!.made_at)).toBe(NOW.getTime());
  });

  it("grades a closed week from its measured days; a week missing a day waits", async () => {
    // The week of 2 Nov ran hotter than last year; the week of 9 Nov lost a day.
    const obs: Observation[] = [];
    for (let i = 0; i < 7; i++) obs.push(revenue(addDays("2026-11-02", i), PER_DAY + 10_000));
    for (let i = 0; i < 7; i++) if (i !== 3) obs.push(revenue(addDays("2026-11-09", i), PER_DAY));
    // A product-level row on the same day never enters the business-wide total.
    obs.push({
      ...revenue("2026-11-02", 999_999),
      dimensions: { product_ref: "mug", currency: "EUR" },
    });
    await upsertObservations(connectionId, "shopify", obs);

    const beat = new Date("2026-11-17T06:00:00Z");
    const run = await runForecastGrading(beat, { profileIds: [profileId] });
    expect(run).toMatchObject({ due: 2, graded: 1, waiting: 1, failed: 0 });
    const graded = (await claimsOf()).find((c) => c.window_start === "2026-11-02")!;
    expect(graded).toMatchObject({
      verdict: "above",
      actual_minor: 7 * (PER_DAY + 10_000),
    });
    expect(Date.parse(graded.graded_at!)).toBe(beat.getTime());
    expect(graded.actual_note).toBe(
      "It came to €4,200, measured by Shopify: €700 over the top of the range.",
    );
    expect((graded.actual_source as { ids: string[] }).ids).toHaveLength(7);

    // Next week's beat: the graded one isn't due again; the gap still waits.
    const next = await runForecastGrading(new Date("2026-11-20T06:00:00Z"), {
      profileIds: [profileId],
    });
    expect(next).toMatchObject({ due: 1, graded: 0, waiting: 1 });
    // Past the patience, the gap is "can't tell", never "inside".
    await runForecastGrading(new Date("2026-11-30T06:00:00Z"), { profileIds: [profileId] });
    const gap = (await claimsOf()).find((c) => c.window_start === "2026-11-09")!;
    expect(gap).toMatchObject({ verdict: "cant_tell", actual_minor: null });
    expect(gap.actual_note).toMatch(/1 day of the week wasn't measured by Shopify/);
  });
});

describe("a stock-out claim, graded from the item's later counts", () => {
  it("is graded below when the stock ran out sooner than I said", async () => {
    await recordForecasts([
      {
        account_id: accountId,
        profile_id: profileId,
        kind: "stock_out",
        forecast_key: `stock_out|${connectionId}:mug|2026-W44`,
        made_at: NOW.toISOString(),
        subject: "Blue Mug",
        subject_ref: {
          connection_id: connectionId,
          product_ref: "mug",
          source: "Shopify",
          on_hand: 12,
          as_of: TODAY,
        },
        metric: "stock.on_hand",
        unit: "date",
        window_start: TODAY,
        window_end: "2026-11-03",
        low_date: "2026-11-01",
        high_date: "2026-11-03",
        claim: "Blue Mug runs out in about 4–6 days.",
        basis: "fixture",
      },
    ]);
    const count = (day: string, q: number): Observation => ({
      metric_key: "stock.on_hand",
      period_date: day,
      dimensions: { product_ref: "mug", item_name: "Blue Mug" },
      value_num: q,
      observed_at: NOW.toISOString(),
    });
    await upsertObservations(connectionId, "shopify", [
      count("2026-10-29", 5),
      count("2026-10-30", 0),
      // Another item's count never grades this one.
      { ...count("2026-11-02", 0), dimensions: { product_ref: "plate", item_name: "Plate" } },
    ]);
    await runForecastGrading(new Date("2026-11-09T06:00:00Z"), { profileIds: [profileId] });
    const [mug] = await db
      .select()
      .from(forecastChecks)
      .where(and(eq(forecastChecks.profile_id, profileId), eq(forecastChecks.kind, "stock_out")));
    expect(mug).toMatchObject({ verdict: "below", actual_date: "2026-10-30" });
    expect(mug!.actual_note).toMatch(/at least 2 days before the earliest day I gave/);
    const ids = (mug!.actual_source as { ids: string[] }).ids;
    const read = await db
      .select({ d: metricObservations.dimensions })
      .from(metricObservations)
      .where(inArray(metricObservations.id, ids));
    expect(read.every((r) => r.d.product_ref === "mug")).toBe(true);
  });
});
