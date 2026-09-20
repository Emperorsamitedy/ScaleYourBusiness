// P2-22..25 — anomalies on a real connection, recorded and surfaced.
//
// The series is seeded through the ordinary observation path, so what is
// tested is the whole chain the nightly sync runs: load the series, judge
// the latest days, write the anomaly with its inputs, write the honest log
// line, cross the interruption rule when the week-over-week fall says so,
// and clear it when the series recovers.

import "dotenv/config";
process.env.CONNECTOR_KEY ??= "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "../../db";
import {
  accounts,
  anomalies,
  businessProfiles,
  connections,
  connectorSyncs,
  fieldRecords,
  metricObservations,
  watchActivity,
} from "../../db/schema";
import type { Observation } from "../connectors/provider";
import { FIXTURE_SECRET } from "../connectors/providers/fixture";
import { connect, upsertObservations } from "../connectors/service";
import { syncConnection } from "../connectors/sync";
import { bootstrapIntake } from "../intake/service";
import { RUN_DAYS, shiftDay, weekdayOf } from "./baseline";
import { detectAnomalies, openInterruptions } from "./detect";
import { REVENUE_WEEK_OVER_WEEK_DROP, thresholdTexts } from "./thresholds";

const NOW = new Date("2026-09-14T12:00:00Z");
const END = "2026-09-13";
const WEEKDAY = [0.6, 1.0, 1.05, 1.1, 1.1, 1.2, 0.75] as const;
const created: { account_id: string; profile_id: string }[] = [];

afterAll(async () => {
  for (const s of created) {
    await db.delete(anomalies).where(eq(anomalies.profile_id, s.profile_id));
    await db.delete(watchActivity).where(eq(watchActivity.profile_id, s.profile_id));
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

async function scenario() {
  const s = await bootstrapIntake();
  created.push(s);
  const conn = await connect(s.account_id, "fixture", FIXTURE_SECRET);
  return { ...s, connection_id: conn.id };
}

/** Sixty days of revenue and orders with the shop's weekday rhythm, ending on END. */
function steadyDays(scale: (date: string) => number = () => 1): Observation[] {
  const out: Observation[] = [];
  for (let i = 59; i >= 0; i -= 1) {
    const date = shiftDay(END, -i);
    const factor = (WEEKDAY[weekdayOf(date)] ?? 1) * (1 + 0.02 * Math.sin(i * 1.7)) * scale(date);
    out.push(
      {
        metric_key: "revenue.daily",
        period_date: date,
        dimensions: { currency: "EUR" },
        value_minor: Math.round(200_000 * factor),
        observed_at: NOW.toISOString(),
      },
      {
        metric_key: "orders.daily",
        period_date: date,
        dimensions: {},
        value_num: Math.round(40 * factor),
        observed_at: NOW.toISOString(),
      },
    );
  }
  return out;
}

const lastNDays = (n: number) => new Set(Array.from({ length: n }, (_, i) => shiftDay(END, -i)));

/** Watch log lines of one kind about the revenue series (orders moves with it in these fixtures). */
const activity = async (profileId: string, kind: string) =>
  (
    await db
      .select()
      .from(watchActivity)
      .where(and(eq(watchActivity.profile_id, profileId), eq(watchActivity.kind, kind)))
  ).filter((row) => (row.meta as { metric_key?: string } | null)?.metric_key === "revenue.daily");

const revenueOutcome = (outcomes: Awaited<ReturnType<typeof detectAnomalies>>) =>
  outcomes.find((o) => o.metric_key === "revenue.daily");

describe("P2-23 / P2-24 — a drop is detected, described, and interrupts when it should", () => {
  it("a steady series is normal, and a weekend is not an alarm", async () => {
    const s = await scenario();
    await upsertObservations(s.connection_id, "fixture", steadyDays());
    const outcomes = await detectAnomalies(s.connection_id, NOW);
    expect(outcomes.map((o) => o.outcome)).toEqual(["normal", "normal"]);
    expect(await activity(s.profile_id, "anomaly_detected")).toHaveLength(0);
  });

  it("a two-day 20% drop is a notice: an anomaly row with its inputs, and one log line", async () => {
    const s = await scenario();
    const dip = lastNDays(RUN_DAYS);
    await upsertObservations(
      s.connection_id,
      "fixture",
      steadyDays((d) => (dip.has(d) ? 0.8 : 1)),
    );

    const outcomes = await detectAnomalies(s.connection_id, NOW);
    expect(revenueOutcome(outcomes)).toMatchObject({
      outcome: "detected",
      direction: "drop",
      severity: "notice",
    });

    const [row] = await db
      .select()
      .from(anomalies)
      .where(
        and(eq(anomalies.profile_id, s.profile_id), eq(anomalies.metric_key, "revenue.daily")),
      );
    expect(row).toMatchObject({
      metric_key: "revenue.daily",
      direction: "drop",
      severity: "notice",
      first_date: shiftDay(END, -1),
      last_date: END,
      run_days: RUN_DAYS,
      resolved_at: null,
    });
    // P2-25: replayable from the row alone.
    const inputs = row?.inputs as {
      baseline: { points: unknown[]; scale: number };
      days: unknown[];
    };
    expect(inputs.baseline.points).toHaveLength(28);
    expect(inputs.days).toHaveLength(RUN_DAYS);
    expect(row?.detail).toMatch(
      /^Revenue \(EUR\) fell \d+% below the expected level for 2 days in a row/,
    );
    expect(row?.detail).toContain("28-day average");
    expect(row?.detail).toContain("threshold 3×");
    expect(row?.detail).not.toContain("interruption threshold");

    const lines = await activity(s.profile_id, "anomaly_detected");
    expect(lines).toHaveLength(1);
    expect(lines[0]?.detail).toBe(row?.detail);
    expect(await openInterruptions(s.profile_id)).toEqual([]);
  });

  it("a week at 60% crosses the 30% week-over-week rule: the watch is interrupted", async () => {
    const s = await scenario();
    const week = lastNDays(7);
    await upsertObservations(
      s.connection_id,
      "fixture",
      steadyDays((d) => (week.has(d) ? 0.6 : 1)),
    );

    const outcomes = await detectAnomalies(s.connection_id, NOW);
    expect(revenueOutcome(outcomes)).toMatchObject({ outcome: "detected", severity: "interrupt" });

    const interruptions = await openInterruptions(s.profile_id);
    expect(interruptions).toHaveLength(1);
    expect(interruptions[0]?.detail).toContain(
      `past the ${Math.round(REVENUE_WEEK_OVER_WEEK_DROP * 100)}% interruption threshold`,
    );
    expect(await activity(s.profile_id, "watch_interrupted")).toHaveLength(1);
    // Orders fell the same way, but only revenue has an interruption rule.
    expect(outcomes.find((o) => o.metric_key === "orders.daily")?.severity).toBe("notice");
  });

  it("a spike is recorded but never interrupts", async () => {
    const s = await scenario();
    const week = lastNDays(7);
    await upsertObservations(
      s.connection_id,
      "fixture",
      steadyDays((d) => (week.has(d) ? 1.6 : 1)),
    );
    expect(revenueOutcome(await detectAnomalies(s.connection_id, NOW))).toMatchObject({
      outcome: "detected",
      direction: "spike",
      severity: "notice",
    });
  });
});

describe("P2-24 / P2-25 — the life of an anomaly", () => {
  it("continues quietly, then clears with one line, and the row is kept", async () => {
    const s = await scenario();
    const dip = lastNDays(RUN_DAYS);
    await upsertObservations(
      s.connection_id,
      "fixture",
      steadyDays((d) => (dip.has(d) ? 0.7 : 1)),
    );
    const first = revenueOutcome(await detectAnomalies(s.connection_id, NOW));
    expect(first?.outcome).toBe("detected");

    // The next night, the same run is still there: nothing new is said.
    const again = revenueOutcome(await detectAnomalies(s.connection_id, NOW));
    expect(again).toMatchObject({ outcome: "continuing", anomaly_id: first?.anomaly_id });
    expect(await activity(s.profile_id, "anomaly_detected")).toHaveLength(1);

    // The series recovers.
    await upsertObservations(s.connection_id, "fixture", steadyDays());
    const cleared = revenueOutcome(await detectAnomalies(s.connection_id, NOW));
    expect(cleared).toMatchObject({ outcome: "cleared", anomaly_id: first?.anomaly_id });
    const [row] = await db
      .select()
      .from(anomalies)
      .where(eq(anomalies.id, first?.anomaly_id ?? ""));
    expect(row?.resolved_at).not.toBeNull();
    expect((await activity(s.profile_id, "anomaly_cleared"))[0]?.detail).toMatch(
      /Revenue \(EUR\) is back within its usual range/,
    );

    // Back to normal, and detection has nothing to say.
    expect(revenueOutcome(await detectAnomalies(s.connection_id, NOW))?.outcome).toBe("normal");
  });

  it("too little history is 'insufficient', not a verdict", async () => {
    const s = await scenario();
    await upsertObservations(s.connection_id, "fixture", steadyDays().slice(-2 * 5)); // 5 days
    expect(revenueOutcome(await detectAnomalies(s.connection_id, NOW))?.outcome).toBe(
      "insufficient",
    );
  });

  it("runs as part of every sync, and the smooth fixture year raises nothing", async () => {
    const s = await scenario();
    const outcome = await syncConnection(s.connection_id, NOW);
    expect(outcome.ok).toBe(true);
    expect(outcome.anomalies.length).toBeGreaterThan(0);
    expect(outcome.anomalies.every((a) => a.outcome === "normal")).toBe(true);
  });
});

describe("P2-24 — the thresholds are code", () => {
  it("lists the enforced rule and is honest about the ones that aren't yet", () => {
    const texts = thresholdTexts();
    expect(texts[0]).toEqual({
      text: "Revenue drops more than 30% week over week",
      enforced: true,
    });
    expect(texts.filter((t) => !t.enforced)).toHaveLength(2);
  });
});
