// P2-13 — sync writes honest watch activity.
//
// The plan's example is "Read 34 days of Stripe payments". These tests hold
// the watch job's honesty rules to it: a line only for real work, the day
// count taken from what is actually on record, and nothing at all for a
// run that read nothing new or failed.

import "dotenv/config";
process.env.CONNECTOR_KEY ??= "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { and, desc, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "../../db";
import {
  accounts,
  businessProfiles,
  connections,
  connectorSyncs,
  fieldRecords,
  metricObservations,
  watchActivity,
} from "../../db/schema";
import { bootstrapIntake } from "../intake/service";
import { activityDetail } from "./activity";
import type { DeriveOutcome } from "./derive";
import { FIXTURE_BACKFILL_DAYS, FIXTURE_FAILING_SECRET, FIXTURE_SECRET } from "./providers/fixture";
import { connect } from "./service";
import { syncConnection } from "./sync";

const NOW = new Date("2026-09-14T12:00:00Z");
const created: { account_id: string; profile_id: string }[] = [];

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

async function scenario(secret = FIXTURE_SECRET) {
  const s = await bootstrapIntake();
  created.push(s);
  const conn = await connect(s.account_id, "fixture", secret);
  return { ...s, connection_id: conn.id };
}

const syncLines = async (profileId: string) =>
  db
    .select()
    .from(watchActivity)
    .where(and(eq(watchActivity.profile_id, profileId), eq(watchActivity.kind, "connector_sync")))
    .orderBy(desc(watchActivity.at));

const written = (field_key: string): DeriveOutcome => ({
  field_key,
  outcome: "written",
  record_id: "record",
  value: 1,
});

describe("P2-13 — the wording", () => {
  it("says how many days were read, in the plan's own words", () => {
    expect(activityDetail("Stripe", "stripe", 34, [])).toBe("Read 34 days of Stripe payments.");
    expect(activityDetail("Stripe", "stripe", 1, [])).toBe("Read 1 day of Stripe payments.");
  });

  it("names only the facts actually written as now measured", () => {
    expect(
      activityDetail("Stripe", "stripe", 34, [
        written("revenue.monthly_revenue"),
        written("revenue.order_count_monthly"),
        { field_key: "marketing.monthly_ad_spend", outcome: "refused", reason: "no ad spend" },
      ]),
    ).toBe("Read 34 days of Stripe payments. Monthly revenue and order count are now measured.");
    expect(
      activityDetail("Stripe", "stripe", 2, [
        { field_key: "revenue.monthly_revenue", outcome: "unchanged", value: 1 },
      ]),
    ).toBe("Read 2 days of Stripe payments.");
  });

  it("a re-read that corrected a figure says so; a run with nothing to say says nothing", () => {
    expect(activityDetail("Stripe", "stripe", 0, [written("revenue.monthly_revenue")])).toBe(
      "Monthly revenue re-measured from Stripe.",
    );
    expect(activityDetail("Stripe", "stripe", 0, [])).toBeNull();
  });
});

describe("P2-13 — the log", () => {
  it("a backfill writes one line naming the days read and the facts now measured", async () => {
    const s = await scenario();
    await syncConnection(s.connection_id, NOW);

    const lines = await syncLines(s.profile_id);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.detail).toBe(
      `Read ${FIXTURE_BACKFILL_DAYS} days of Fixture data. Monthly revenue, order count and ad spend are now measured.`,
    );
    expect(lines[0]?.meta).toMatchObject({ new_days: FIXTURE_BACKFILL_DAYS, provider: "fixture" });
  });

  it("a second run the same day reads nothing new and writes nothing", async () => {
    const s = await scenario();
    await syncConnection(s.connection_id, NOW);
    await syncConnection(s.connection_id, NOW);
    expect(await syncLines(s.profile_id)).toHaveLength(1);
  });

  it("the next day adds one line for one new day", async () => {
    const s = await scenario();
    await syncConnection(s.connection_id, NOW);
    await syncConnection(s.connection_id, new Date("2026-09-15T12:00:00Z"));

    const lines = await syncLines(s.profile_id);
    expect(lines).toHaveLength(2);
    expect(lines[0]?.detail).toMatch(/^Read 1 day of Fixture data\./);
  });

  it("a failed sync writes nothing to the activity log", async () => {
    const s = await scenario(FIXTURE_FAILING_SECRET);
    await syncConnection(s.connection_id, NOW);
    expect(await syncLines(s.profile_id)).toHaveLength(0);
  });
});
