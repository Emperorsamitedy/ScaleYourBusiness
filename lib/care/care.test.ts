// Session H + J foundations — P3-40b, P3-42, P3-43, P3-44.
//
// The internal flag keeps SYB's own numbers out of every cross-customer
// figure while its own scorecard keeps working; day zero is recorded
// once, verifiably; a measurable goal's baseline is MEASURED with its
// provenance named; and goal progress is arithmetic with every threshold
// pinned at its boundary in both directions, plus the alert sequence:
// three consecutive off-track weeks, raised once.

import "dotenv/config";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { dayMonthYear } from "../i18n/format";
import { db } from "../../db";
import {
  accounts,
  businessProfiles,
  connections,
  decisionLog,
  fieldRecords,
  goals,
  intakeEvents,
  llmCalls,
  metricObservations,
  modeDecisions,
  profileSnapshots,
  proposals,
  users,
  watchActivity,
} from "../../db/schema";
import { bootstrapIntake } from "../intake/service";
import { recordLlmCall } from "../llm/cost-log";
import { setAccountInternal } from "../ops/internal";
import { costSummary, funnelSummary } from "../ops/summary";
import { readCurrentField } from "../profile/field-store";
import { approveProposal, createProposal, rejectProposal } from "../proposals/service";
import { crossCustomerApprovalRate } from "../trust/gate";
import { buildTrustView } from "../trust/scorecard";
import { shiftDay } from "../trust/series";
import { careState, hashTakeoverPayload, recordDayZero } from "./day-zero";
import type { GoalBaseline, GoalMeasure } from "./goal-measure";
import { GoalMeasureError, ensureBaseline, readGoalMeasure, setGoalMeasure } from "./goal-measure";
import { PROGRESS, assessProgress, checkGoal } from "./progress";

const created: { account_id: string; profile_id: string }[] = [];
const LONG_AGO = new Date(0).toISOString();
const DAY_MS = 86_400_000;

const scenario = {
  assumptions: [],
  base_case: { case: "base", statement: "t", profit_delta_monthly: null, formula: null },
  downside_case: { case: "downside", statement: "t", profit_delta_monthly: null, formula: null },
  upside_case: { case: "upside", statement: "t", profit_delta_monthly: null, formula: null },
  breakeven_condition: "none — fixture",
} as never;

async function fresh() {
  const s = await bootstrapIntake();
  created.push(s);
  const [u] = await db
    .insert(users)
    .values({
      account_id: s.account_id,
      email: `p3-j-${crypto.randomUUID()}@test.local`,
      display_name: "Session J owner",
      role: "owner",
    })
    .returning({ id: users.id });
  return { ...s, user_id: u!.id };
}

async function decided(s: { profile_id: string; user_id: string }, outcome: "approve" | "reject") {
  const row = await createProposal({
    profile_id: s.profile_id,
    module: "diagnosis",
    action: { kind: "price_increase", summary: "fixture" },
    scenario,
    reversibility: { level: "easy", if_you_change_your_mind: "undo" },
    expires_at: new Date(Date.now() + DAY_MS).toISOString(),
  });
  if (outcome === "approve") await approveProposal({ proposalId: row.id, userId: s.user_id });
  else await rejectProposal({ proposalId: row.id, userId: s.user_id, reason: "not now" });
}

/** Flat daily revenue (minor units, EUR) on every day from..to inclusive. */
async function seedRevenue(accountId: string, from: string, to: string, perDay: number) {
  let [conn] = await db
    .select({ id: connections.id })
    .from(connections)
    .where(eq(connections.account_id, accountId));
  if (!conn) {
    [conn] = await db
      .insert(connections)
      .values({ account_id: accountId, provider: "stripe" })
      .returning({ id: connections.id });
  }
  const rows = [];
  for (let day = from; day <= to; day = shiftDay(day, 1)) {
    rows.push({
      connection_id: conn!.id,
      provider: "stripe",
      metric_key: "revenue.daily",
      dimensions: { currency: "EUR" },
      dimension_key: '{"currency":"EUR"}',
      period_date: day,
      value_minor: perDay,
      currency: "EUR",
      observed_at: new Date().toISOString(),
    });
  }
  await db.insert(metricObservations).values(rows).onConflictDoNothing();
}

async function newGoal(profileId: string, horizon: string | null = "6_months") {
  const [g] = await db.insert(goals).values({ profile_id: profileId }).returning({ id: goals.id });
  if (horizon) {
    const { writeField } = await import("../profile/field-store");
    const { createField } = await import("../core/field");
    const { fieldId } = await import("../core/ids");
    const { isoDateTime } = await import("../core/iso");
    const at = isoDateTime(new Date().toISOString());
    await writeField(
      profileId,
      createField<string>({
        id: fieldId(`goals.${g!.id}.horizon`),
        value: horizon,
        status: "answered",
        confidence: 0.75,
        source: { kind: "owner_input" },
        observed_at: at,
        recorded_at: at,
      }),
    );
  }
  return g!.id;
}

afterAll(async () => {
  const ids = created.map((s) => s.profile_id);
  if (ids.length > 0) {
    await db.delete(watchActivity).where(inArray(watchActivity.profile_id, ids));
    await db.delete(modeDecisions).where(inArray(modeDecisions.profile_id, ids));
    await db.delete(proposals).where(inArray(proposals.profile_id, ids));
    await db.delete(profileSnapshots).where(inArray(profileSnapshots.profile_id, ids));
    await db.delete(intakeEvents).where(inArray(intakeEvents.profile_id, ids));
    await db.delete(fieldRecords).where(inArray(fieldRecords.profile_id, ids));
    await db.delete(goals).where(inArray(goals.profile_id, ids));
  }
  for (const s of created) {
    const conns = await db
      .select({ id: connections.id })
      .from(connections)
      .where(eq(connections.account_id, s.account_id));
    if (conns.length > 0) {
      await db.delete(metricObservations).where(
        inArray(
          metricObservations.connection_id,
          conns.map((c) => c.id),
        ),
      );
      await db.delete(connections).where(eq(connections.account_id, s.account_id));
    }
    await db.delete(llmCalls).where(eq(llmCalls.account_id, s.account_id));
    await db.delete(users).where(eq(users.account_id, s.account_id));
  }
  if (ids.length > 0) await db.delete(businessProfiles).where(inArray(businessProfiles.id, ids));
  for (const s of created) await db.delete(accounts).where(eq(accounts.id, s.account_id));
});

describe("P3-40b — internal accounts stay out of customer evidence", () => {
  it("Gate 2's cross-customer rate drops exactly the internal profile's decisions", async () => {
    const before = await crossCustomerApprovalRate();
    const customer = await fresh();
    const ours = await fresh();
    await decided(customer, "approve");
    await decided(customer, "reject");
    await decided(ours, "approve");
    await decided(ours, "approve");

    const both = await crossCustomerApprovalRate();
    expect(both.counts.approved - before.counts.approved).toBe(3);
    expect(both.profiles - before.profiles).toBe(2);

    await setAccountInternal(ours.account_id, true);
    const after = await crossCustomerApprovalRate();
    expect(after.counts.approved - before.counts.approved).toBe(1);
    expect(after.counts.rejected - before.counts.rejected).toBe(1);
    expect(after.profiles - before.profiles).toBe(1);
    expect(after.arithmetic).toContain("customer profile(s)");

    // Its own scorecard is untouched: the business is still a business.
    const own = await buildTrustView(ours.profile_id);
    expect(own.scorecard.approved).toBe(2);
    expect(own.scorecard.approval_rate.value).toBe(100);
  });

  it("the ops funnel and cost view leave the internal account out", async () => {
    const funnelBefore = await funnelSummary(LONG_AGO);
    const ours = await fresh(); // bootstrap writes funnel_intake_started
    await recordLlmCall({
      at: new Date().toISOString(),
      event: "llm_call",
      workload: "interviewer",
      account_id: ours.account_id,
      model: "claude-sonnet-5",
      duration_ms: 1000,
      input_tokens: 100,
      output_tokens: 10,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      cost_eur: 0.01,
    });
    const counted = await funnelSummary(LONG_AGO);
    expect(counted.started - funnelBefore.started).toBe(1);
    expect(
      (await costSummary(LONG_AGO)).accounts.some((a) => a.account_id === ours.account_id),
    ).toBe(true);

    await setAccountInternal(ours.account_id, true);
    expect((await funnelSummary(LONG_AGO)).started).toBe(funnelBefore.started);
    expect(
      (await costSummary(LONG_AGO)).accounts.some((a) => a.account_id === ours.account_id),
    ).toBe(false);
  });

  it("an unknown account cannot be flagged", async () => {
    await expect(setAccountInternal(crypto.randomUUID(), true)).rejects.toThrow("no account");
  });
});

describe("P3-43 — day zero", () => {
  it("is recorded once, as a snapshot plus a takeover entry whose hash can be checked", async () => {
    const s = await fresh();
    const goalId = await newGoal(s.profile_id);
    const decisionId = crypto.randomUUID();
    const first = await recordDayZero(s.profile_id, decisionId);
    const again = await recordDayZero(s.profile_id, crypto.randomUUID());
    expect(again.snapshot_id).toBe(first.snapshot_id);

    const entries = await db
      .select()
      .from(decisionLog)
      .where(and(eq(decisionLog.profile_id, s.profile_id), eq(decisionLog.kind, "takeover")));
    expect(entries).toHaveLength(1);
    const [snap] = await db
      .select()
      .from(profileSnapshots)
      .where(eq(profileSnapshots.id, first.snapshot_id));
    expect(snap?.reason).toBe("day_zero");
    expect(entries[0]!.payload_hash).toBe(
      hashTakeoverPayload({
        profile_id: s.profile_id,
        decision_id: decisionId,
        snapshot_id: first.snapshot_id,
        content_hash: snap!.content_hash,
        goal_ids: [goalId],
      }),
    );

    const care = await careState(s.profile_id);
    expect(care?.recorded).toBe(true);
    expect(care?.snapshot_id).toBe(first.snapshot_id);
    expect(care?.watch_ends_at).toBeNull();
  });

  it("falls back to the first mode decision for profiles in care before P3-43, and reads the watch", async () => {
    const s = await fresh();
    expect(await careState(s.profile_id)).toBeNull();
    const reviewAt = new Date(Date.now() + 42 * DAY_MS).toISOString();
    await db.insert(modeDecisions).values({
      profile_id: s.profile_id,
      mode: "watching",
      watch_weeks: 6,
      inputs: {},
      reasoning: "fixture",
      confidence: "0.800",
      review_at: reviewAt,
    });
    const care = await careState(s.profile_id);
    expect(care?.recorded).toBe(false);
    expect(care?.snapshot_id).toBeNull();
    expect(care?.watch_ends_at?.slice(0, 10)).toBe(reviewAt.slice(0, 10));
  });
});

describe("P3-42 — measurable goals", () => {
  const NOW = new Date();
  const TODAY = NOW.toISOString().slice(0, 10);

  it("refuses what it can't measure, by name", async () => {
    const s = await fresh();
    const goalId = await newGoal(s.profile_id);
    const noHorizon = await newGoal(s.profile_id, null);
    const attempt = (id: string, input: Parameters<typeof setGoalMeasure>[2]) =>
      setGoalMeasure(s.profile_id, id, input, NOW);
    await expect(attempt(goalId, { metric: "happiness", target_per_30d: 1 })).rejects.toThrow(
      "metric must be one of",
    );
    await expect(attempt(goalId, { metric: "revenue", target_per_30d: 100 })).rejects.toThrow(
      "needs its currency",
    );
    await expect(
      attempt(goalId, { metric: "revenue", target_per_30d: 10.5, currency: "EUR" }),
    ).rejects.toThrow("positive whole number");
    await expect(attempt(noHorizon, { metric: "orders", target_per_30d: 50 })).rejects.toThrow(
      "needs a deadline",
    );
    await expect(
      setGoalMeasure((await fresh()).profile_id, goalId, { metric: "orders", target_per_30d: 5 }),
    ).rejects.toBeInstanceOf(GoalMeasureError);
  });

  it("measures the baseline from the 28 days before, naming the series it came from", async () => {
    const s = await fresh();
    const goalId = await newGoal(s.profile_id);
    await seedRevenue(s.account_id, shiftDay(TODAY, -28), shiftDay(TODAY, -1), 10_000);
    const set = await setGoalMeasure(
      s.profile_id,
      goalId,
      { metric: "revenue", target_per_30d: 390_000, currency: "eur" },
      NOW,
    );
    expect(set.measure.currency).toBe("EUR");
    expect(set.measure.deadline > TODAY).toBe(true);
    expect(set.baseline?.per_30d).toBe(300_000);
    expect(set.baseline?.days_measured).toBe(28);

    const field = await readCurrentField<GoalBaseline>(s.profile_id, `goals.${goalId}.baseline`);
    expect(field?.status).toBe("inferred");
    expect(field?.source).toMatchObject({
      kind: "inferred",
      derived_from: ["connector:stripe:revenue.daily"],
    });
    expect((field?.source as { method: string }).method).toContain("× 30");
  });

  it("refuses a target the business already meets", async () => {
    const s = await fresh();
    const goalId = await newGoal(s.profile_id);
    await seedRevenue(s.account_id, shiftDay(TODAY, -28), shiftDay(TODAY, -1), 10_000);
    await expect(
      setGoalMeasure(
        s.profile_id,
        goalId,
        { metric: "revenue", target_per_30d: 300_000, currency: "EUR" },
        NOW,
      ),
    ).rejects.toThrow("already reached");
  });

  it("20 measured days give no baseline, said plainly; a later backfill fills it", async () => {
    const s = await fresh();
    const goalId = await newGoal(s.profile_id);
    await seedRevenue(s.account_id, shiftDay(TODAY, -20), shiftDay(TODAY, -1), 10_000);
    const set = await setGoalMeasure(
      s.profile_id,
      goalId,
      { metric: "revenue", target_per_30d: 390_000, currency: "EUR" },
      NOW,
    );
    expect(set.baseline).toBeNull();
    expect(set.baseline_note).toContain("needs 21");

    await seedRevenue(s.account_id, shiftDay(TODAY, -28), shiftDay(TODAY, -21), 10_000);
    expect(await ensureBaseline(s.profile_id, goalId)).toBe(true);
    expect((await readGoalMeasure(s.profile_id, goalId)).baseline?.per_30d).toBe(300_000);
  });
});

describe("P3-44 — progress thresholds, at the boundary, both directions", () => {
  // A 200-day path; "today" is day 120, so 60% of the way along.
  const measure = (
    target: number,
    direction: "increase" | "decrease" = "increase",
  ): GoalMeasure => ({
    metric: "revenue",
    direction,
    target_per_30d: target,
    currency: "EUR",
    set_on: "2026-01-01",
    deadline: shiftDay("2026-01-01", 200),
  });
  const baseline: GoalBaseline = {
    per_30d: 300_000,
    currency: "EUR",
    from: "2025-12-04",
    to: "2025-12-31",
    days_measured: 28,
  };
  const care = { day_zero: "2025-11-01T00:00:00.000Z", watch_ends_at: null };
  const TODAY = shiftDay("2026-01-01", 120);
  const at = (target: number, meanPerDay: number, direction?: "increase" | "decrease") =>
    assessProgress({
      measure: measure(target, direction),
      baseline,
      current: { mean_minor: meanPerDay, days_measured: 28 },
      care,
      today: TODAY,
    });

  // +30% goal: expected by now = 300 000 + 90 000 × 0.6 = 354 000.
  it("exactly 70% of the expected progress is on track; just under is lagging", () => {
    const edge = at(390_000, 11_260); // 337 800: progress 37 800 / 54 000 = 0.70
    expect(edge.ratio).toBe(0.7);
    expect(edge.verdict).toBe("on_track");
    expect(at(390_000, 11_259).verdict).toBe("lagging");
  });

  it("exactly 40% is lagging; just under is off track", () => {
    const edge = at(390_000, 10_720); // 321 600: 21 600 / 54 000 = 0.40
    expect(edge.ratio).toBe(0.4);
    expect(edge.verdict).toBe("lagging");
    expect(at(390_000, 10_719).verdict).toBe("off_track");
  });

  it("the noise floor scales the alert with the gap: a 5% shortfall counts, 4.99% doesn't", () => {
    // Target 325 000: expected by now 315 000; flat at baseline = 5.0% behind.
    const flat = at(325_000, 10_000);
    expect(flat.shortfall).toBe(0.05);
    expect(flat.verdict).toBe("off_track");
    // One cent a day better: 14 970 behind = 4.99% — noise, whatever the ratio says.
    const noise = at(325_000, 10_001);
    expect(noise.ratio).toBeLessThan(PROGRESS.off_track_below);
    expect(noise.verdict).toBe("on_track");
    // A small goal (+5%) standing still is never more than noise this early.
    expect(at(315_000, 10_000).verdict).toBe("on_track");
  });

  it("falling below the baseline is named as moving away", () => {
    const away = at(390_000, 9_500);
    expect(away.verdict).toBe("off_track");
    expect(away.arithmetic).toContain("moving away");
  });

  it("reaching the target is achieved, and the arithmetic shows the path", () => {
    const done = at(390_000, 13_000);
    expect(done.verdict).toBe("achieved");
    expect(done.arithmetic).toContain("per 30 days");
    // The deadline, written out as the owner reads it ("20 Jul 2026").
    expect(done.arithmetic).toContain(dayMonthYear(measure(390_000).deadline, "en"));
  });

  it("a decrease goal mirrors it: standing still is off track, on the path is on track", () => {
    // 300 000 → 240 000: expected by now 264 000.
    expect(at(240_000, 10_000, "decrease").verdict).toBe("off_track");
    expect(at(240_000, 8_800, "decrease").verdict).toBe("on_track");
    expect(at(240_000, 7_900, "decrease").verdict).toBe("achieved");
  });

  it("too early: inside 8 weeks of care, inside the watch, or the goal's first window", () => {
    const base = {
      measure: measure(390_000),
      baseline,
      current: { mean_minor: 10_000, days_measured: 28 },
      today: TODAY,
    };
    const recent = { day_zero: `${shiftDay(TODAY, -55)}T00:00:00.000Z`, watch_ends_at: null };
    expect(assessProgress({ ...base, care: recent }).verdict).toBe("too_early");
    const eightWeeks = { day_zero: `${shiftDay(TODAY, -56)}T00:00:00.000Z`, watch_ends_at: null };
    expect(assessProgress({ ...base, care: eightWeeks }).verdict).toBe("off_track");

    const watching = { ...care, watch_ends_at: `${shiftDay(TODAY, 1)}T00:00:00.000Z` };
    expect(assessProgress({ ...base, care: watching }).arithmetic).toContain("watching period");
    expect(assessProgress({ ...base, care: null }).verdict).toBe("too_early");

    const young = { ...measure(390_000), set_on: shiftDay(TODAY, -27) };
    expect(assessProgress({ ...base, care, measure: young }).verdict).toBe("too_early");
  });

  it("20 measured days is too early; 21 makes a verdict; none at all is unmeasured", () => {
    const base = { measure: measure(390_000), baseline, care, today: TODAY };
    expect(
      assessProgress({ ...base, current: { mean_minor: 10_000, days_measured: 20 } }).verdict,
    ).toBe("too_early");
    expect(
      assessProgress({ ...base, current: { mean_minor: 10_000, days_measured: 21 } }).verdict,
    ).toBe("off_track");
    expect(assessProgress({ ...base, current: null }).verdict).toBe("unmeasured");
    expect(
      assessProgress({ ...base, baseline: null, current: { mean_minor: 1, days_measured: 28 } })
        .verdict,
    ).toBe("unmeasured");
  });
});

describe("P3-44 — the alert: three off-track weeks in a row, raised once", () => {
  it("raises on the third consecutive off-track check, not before, and not again", async () => {
    const s = await fresh();
    const goalId = await newGoal(s.profile_id);
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    await seedRevenue(s.account_id, shiftDay(today, -28), shiftDay(today, 100), 10_000);
    await setGoalMeasure(
      s.profile_id,
      goalId,
      { metric: "revenue", target_per_30d: 390_000, currency: "EUR" },
      now,
    );
    await recordDayZero(s.profile_id, crypto.randomUUID());
    const care = await careState(s.profile_id);
    const later = (days: number) => new Date(now.getTime() + days * DAY_MS);

    const results = [];
    for (const day of [70, 77, 84])
      results.push(await checkGoal(s.profile_id, goalId, care, later(day)));
    expect(results.map((r) => r.alert_raised)).toEqual([false, false, true]);

    // Three days later: inside the weekly spacing, not checked at all.
    expect((await checkGoal(s.profile_id, goalId, care, later(87))).checked).toBe(false);
    // A fourth off-track week keeps the alert, without raising it twice.
    expect((await checkGoal(s.profile_id, goalId, care, later(91))).alert_raised).toBe(false);

    const log = await db
      .select({ kind: watchActivity.kind, detail: watchActivity.detail })
      .from(watchActivity)
      .where(eq(watchActivity.profile_id, s.profile_id));
    expect(log.filter((r) => r.kind === "goal_progress")).toHaveLength(4);
    const alerts = log.filter((r) => r.kind === "goal_alert");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.detail).toContain("3 weekly checks");
    expect(log.find((r) => r.kind === "goal_progress")!.detail).toMatch(/^Off track:/);
  });

  it("an on-track week resets the count", async () => {
    const s = await fresh();
    const goalId = await newGoal(s.profile_id);
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    await seedRevenue(s.account_id, shiftDay(today, -28), shiftDay(today, 76), 10_000);
    await setGoalMeasure(
      s.profile_id,
      goalId,
      { metric: "revenue", target_per_30d: 390_000, currency: "EUR" },
      now,
    );
    await recordDayZero(s.profile_id, crypto.randomUUID());
    const care = await careState(s.profile_id);
    const later = (days: number) => new Date(now.getTime() + days * DAY_MS);

    await checkGoal(s.profile_id, goalId, care, later(70));
    await checkGoal(s.profile_id, goalId, care, later(77));
    // Revenue doubles from day 77: the next window is well ahead of the path.
    await seedRevenue(s.account_id, shiftDay(today, 77), shiftDay(today, 110), 20_000);
    const third = await checkGoal(s.profile_id, goalId, care, later(84));
    expect(third.alert_raised).toBe(false);
    const metas = (
      await db
        .select({ meta: watchActivity.meta, at: watchActivity.at })
        .from(watchActivity)
        .where(
          and(eq(watchActivity.profile_id, s.profile_id), eq(watchActivity.kind, "goal_progress")),
        )
    )
      .sort((a, b) => a.at.localeCompare(b.at))
      .map((r) => r.meta as { verdict: string; consecutive_off_track: number });
    expect(metas.map((m) => m.consecutive_off_track)).toEqual([1, 2, 0]);
  });
});
