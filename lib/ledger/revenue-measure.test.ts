// D89: the revenue measurer — the season is taken out, the interval is
// honest, and anything it can't separate it refuses to score.

import "dotenv/config";
import { describe, expect, it } from "vitest";
import { db } from "../../db";
import { connections, metricObservations } from "../../db/schema";
import { money } from "../core/money";
import { bootstrapIntake } from "../intake/service";
import { verdictOf } from "./close";
import type { OpenPlanInput } from "./plans";
import { openPlan } from "./plans";
import type { Arms } from "./revenue-measure";
import {
  NotSyncedYetError,
  armDays,
  beforeOffset,
  differenceInDifferences,
  measureRevenue,
  t95,
} from "./revenue-measure";

const N = 28;

/** A deterministic noise source (an LCG), so every run sees the same days. */
function noise(seed: number, amplitude: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1_103_515_245 + 12_345) % 2_147_483_648;
    return Math.round(((s / 2_147_483_648) * 2 - 1) * amplitude);
  };
}

/** A weekly shape (weekends busier), a level, and noise. */
function days(level: number, amplitude: number, seed: number, lift = 0): number[] {
  const r = noise(seed, amplitude);
  return Array.from({ length: N }, (_, i) => level + (i % 7 >= 5 ? 20_000 : 0) + lift + r());
}

function arms(over: Partial<Arms> = {}): Arms {
  return {
    before: days(100_000, 8_000, 1),
    after: days(100_000, 8_000, 2),
    beforeLastYear: days(90_000, 8_000, 3),
    afterLastYear: days(90_000, 8_000, 4),
    ...over,
  };
}

const plan = (expected: number) => ({
  design: "pre_post_adjusted" as const,
  expected_effect_minor: expected,
});

describe("D89 — difference in differences against the same weeks a year earlier", () => {
  it("a seasonal rise that happened last year too is not credited to the action", () => {
    // Every year the window's weeks run 30 000 a day above the weeks before.
    const a = arms({
      after: days(130_000, 8_000, 2),
      afterLastYear: days(120_000, 8_000, 4),
    });
    // A plain before/after would have called this a big gain…
    const naive = a.after.reduce((s, v) => s! + v!, 0)! - a.before.reduce((s, v) => s! + v!, 0)!;
    expect(naive).toBeGreaterThan(700_000);
    // …the seasonal control takes it out.
    const o = differenceInDifferences(a, N);
    expect(verdictOf(plan(150_000), o)).not.toBe("verified_gain");
    if ("inconclusive" in o) throw new Error("expected a score");
    expect(o.low_minor).toBeLessThan(0);
    expect(o.high_minor).toBeGreaterThan(0);
  });

  it("a real lift on top of the season is a verified gain, sized near the truth", () => {
    const a = arms({
      after: days(130_000, 8_000, 2, 10_000),
      afterLastYear: days(120_000, 8_000, 4),
    });
    const o = differenceInDifferences(a, N);
    if ("inconclusive" in o) throw new Error("expected a score");
    expect(verdictOf(plan(280_000), o)).toBe("verified_gain");
    expect(o.low_minor).toBeGreaterThan(0);
    // The true effect (10 000 a day × 28) sits inside the interval.
    expect(o.low_minor).toBeLessThanOrEqual(280_000);
    expect(o.high_minor).toBeGreaterThanOrEqual(280_000);
  });

  it("a real drop is a loss", () => {
    const o = differenceInDifferences(arms({ after: days(100_000, 8_000, 2, -12_000) }), N);
    expect(verdictOf(plan(100_000), o)).toBe("loss");
  });

  it("a small effect buried in noise is inconclusive, never a gain", () => {
    const noisy = (seed: number, lift = 0) => days(100_000, 60_000, seed, lift);
    const o = differenceInDifferences(
      {
        before: noisy(11),
        after: noisy(12, 3_000),
        beforeLastYear: noisy(13),
        afterLastYear: noisy(14),
      },
      N,
    );
    expect(verdictOf(plan(84_000), o)).toBe("inconclusive");
  });

  it("every figure is whole minor units and the observed effect sits inside its interval", () => {
    const o = differenceInDifferences(arms({ after: days(100_000, 8_000, 2, 5_000) }), N);
    if ("inconclusive" in o) throw new Error("expected a score");
    for (const v of [o.observed_minor, o.low_minor, o.high_minor]) {
      expect(Number.isSafeInteger(v)).toBe(true);
    }
    expect(o.low_minor).toBeLessThanOrEqual(o.observed_minor);
    expect(o.observed_minor).toBeLessThanOrEqual(o.high_minor);
    expect(o.method_notes).toMatch(/year earlier/);
  });

  it("an identical effect every day has no spread, so no width", () => {
    const flat = (v: number) => Array.from({ length: N }, () => v);
    const o = differenceInDifferences(
      { before: flat(100), after: flat(150), beforeLastYear: flat(100), afterLastYear: flat(100) },
      N,
    );
    expect(o).toMatchObject({ observed_minor: 50 * N, low_minor: 50 * N, high_minor: 50 * N });
  });

  it("day-to-day correlation widens the interval", () => {
    // The same daily effects, once alternating and once in long runs.
    const base = Array.from({ length: N }, () => 100_000);
    const alternating = base.map((v, i) => v + (i % 2 === 0 ? 5_000 : -5_000));
    const runs = base.map((v, i) => v + (Math.floor(i / 7) % 2 === 0 ? 5_000 : -5_000));
    const width = (after: number[]) => {
      const o = differenceInDifferences(
        { before: base, after, beforeLastYear: base, afterLastYear: base },
        N,
      );
      if ("inconclusive" in o) throw new Error("expected a score");
      return o.high_minor - o.low_minor;
    };
    expect(width(runs)).toBeGreaterThan(width(alternating));
  });

  it("refuses to score when fewer than three quarters of the days are measured in all four arms", () => {
    const gaps = days(100_000, 8_000, 2).map((v, i) => (i < 8 ? undefined : v));
    const o = differenceInDifferences(arms({ after: gaps }), N);
    expect(o).toEqual({ inconclusive: expect.stringMatching(/Only 20 of 28 days.*needs 21/) });
    // 21 measured is enough.
    const fewer = days(100_000, 8_000, 2).map((v, i) => (i < 7 ? undefined : v));
    expect("inconclusive" in differenceInDifferences(arms({ after: fewer }), N)).toBe(false);
  });
});

describe("D89 — the arms line up by weekday", () => {
  it("before-days are whole weeks back, clear of the action's own day", () => {
    expect(beforeOffset(28)).toBe(35);
    expect(beforeOffset(27)).toBe(28);
    expect(beforeOffset(7)).toBe(14);
  });

  it("every pair compares the same weekday, this year and 52 weeks earlier", () => {
    const d = armDays("2026-03-01T10:00:00.000Z", "2026-03-29T10:00:00.000Z");
    expect(d.n).toBe(28);
    expect(d.after[0]).toBe("2026-03-02"); // the action's own day is left out
    expect(d.after[27]).toBe("2026-03-29");
    const weekday = (day: string) => new Date(`${day}T00:00:00Z`).getUTCDay();
    for (let i = 0; i < d.n; i++) {
      const w = weekday(d.after[i]!);
      expect(weekday(d.before[i]!)).toBe(w);
      expect(weekday(d.afterLastYear[i]!)).toBe(w);
      expect(weekday(d.beforeLastYear[i]!)).toBe(w);
      expect(d.before[i]! < "2026-03-01").toBe(true);
    }
  });

  it("the t value is conservative between tabled degrees of freedom", () => {
    expect(t95(20)).toBe(2.086);
    expect(t95(22)).toBe(2.086);
    expect(t95(27)).toBe(2.06);
    expect(t95(500)).toBe(1.98);
  });
});

// ── Against the database: the refusals ───────────────────────────────────

const OPEN = new Date("2026-03-01T10:00:00.000Z");
const CLOSE = new Date("2026-04-02T00:00:00.000Z");
const ARMS = armDays(OPEN.toISOString(), "2026-03-29T10:00:00.000Z");

async function business(
  values: Record<string, number>,
  currency = "EUR",
): Promise<{ account_id: string; profile_id: string }> {
  const s = await bootstrapIntake();
  const [conn] = await db
    .insert(connections)
    .values({ account_id: s.account_id, provider: "stripe" })
    .returning({ id: connections.id });
  const rows = Object.entries(values).map(([period_date, value_minor]) => ({
    connection_id: conn!.id,
    provider: "stripe",
    metric_key: "revenue.daily",
    dimensions: { currency },
    dimension_key: JSON.stringify({ currency }),
    period_date,
    value_minor,
    currency,
    observed_at: new Date().toISOString(),
  }));
  if (rows.length > 0) await db.insert(metricObservations).values(rows);
  return s;
}

/** Revenue on every arm's days: last year flat, this year flat, plus a lift after. */
function history(lift: number, opts: { lastYear?: boolean; lastDay?: boolean } = {}) {
  const v: Record<string, number> = {};
  const r = noise(7, 3_000);
  ARMS.before.forEach((d) => (v[d] = 100_000 + r()));
  ARMS.after.forEach((d) => (v[d] = 100_000 + lift + r()));
  if (opts.lastYear !== false) {
    ARMS.beforeLastYear.forEach((d) => (v[d] = 90_000 + r()));
    ARMS.afterLastYear.forEach((d) => (v[d] = 90_000 + r()));
  }
  if (opts.lastDay === false) delete v[ARMS.after[ARMS.n - 1]!];
  return v;
}

function input(s: { account_id: string; profile_id: string }, over: Partial<OpenPlanInput> = {}) {
  return {
    profileId: s.profile_id,
    accountId: s.account_id,
    provider: "meta_ads",
    action_summary: "Raise the daily budget",
    hypothesis: "More reach brings more orders",
    expected: { effect: money(200_000, "EUR"), low: money(0, "EUR"), high: money(400_000, "EUR") },
    currency: "EUR",
    reversible: true,
    opened_by: "agent" as const,
    station: 3 as const,
    shadow: false,
    now: OPEN,
    ...over,
  } satisfies OpenPlanInput;
}

describe("D89 — measureRevenue against a connected series", () => {
  it("scores a real lift with a year of history as a verified gain", async () => {
    const s = await business(history(10_000));
    const { plan } = await openPlan(input(s));
    const o = await measureRevenue(plan, CLOSE);
    if ("inconclusive" in o) throw new Error(o.inconclusive);
    expect(verdictOf(plan, o)).toBe("verified_gain");
    expect(plan.confidence_grade).toBe("C");
  });

  it("refuses to score a before/after with no year of history", async () => {
    const s = await business(history(10_000, { lastYear: false }));
    const { plan } = await openPlan(input(s));
    expect(await measureRevenue(plan, CLOSE)).toEqual({
      inconclusive: expect.stringMatching(/same weeks a year earlier/),
    });
  });

  it("refuses to credit either of two actions that ran in the same weeks", async () => {
    const s = await business(history(10_000));
    const { plan } = await openPlan(input(s));
    await openPlan(
      input(s, { provider: "meta_publish", now: new Date("2026-03-10T09:00:00.000Z") }),
    );
    expect(await measureRevenue(plan, CLOSE)).toEqual({
      inconclusive: expect.stringMatching(/Another change ran in the same weeks/),
    });
  });

  it("an action in the same weeks a year earlier blocks it too — last year's baseline carries it", async () => {
    const s = await business(history(10_000));
    const { plan } = await openPlan(input(s));
    await openPlan(input(s, { now: new Date("2025-03-05T09:00:00.000Z") }));
    expect(await measureRevenue(plan, CLOSE)).toEqual({
      inconclusive: expect.stringMatching(/Another change/),
    });
  });

  it("a shadow plan did nothing, so it blocks nothing", async () => {
    const s = await business(history(10_000));
    const { plan } = await openPlan(input(s));
    await openPlan(input(s, { shadow: true, now: new Date("2026-03-10T09:00:00.000Z") }));
    expect("inconclusive" in (await measureRevenue(plan, CLOSE))).toBe(false);
  });

  it("waits for the last day to sync, then scores without it after the grace days", async () => {
    const s = await business(history(10_000, { lastDay: false }));
    const { plan } = await openPlan(input(s));
    await expect(measureRevenue(plan, new Date("2026-03-30T00:00:00.000Z"))).rejects.toThrow(
      NotSyncedYetError,
    );
    expect("inconclusive" in (await measureRevenue(plan, CLOSE))).toBe(false);
  });

  it("never converts: a plan in another currency than the series isn't scored", async () => {
    const s = await business(history(10_000));
    const { plan } = await openPlan(
      input(s, {
        currency: "USD",
        expected: {
          effect: money(200_000, "USD"),
          low: money(0, "USD"),
          high: money(400_000, "USD"),
        },
      }),
    );
    expect(await measureRevenue(plan, CLOSE)).toEqual({
      inconclusive: expect.stringMatching(/nothing is converted/),
    });
  });

  it("a plan scored on something other than revenue isn't scored on revenue", async () => {
    const s = await business(history(10_000));
    const { plan } = await openPlan(input(s, { provider: "purchase_order" }));
    expect(await measureRevenue(plan, CLOSE)).toEqual({
      inconclusive: expect.stringMatching(/cash days/),
    });
  });
});
