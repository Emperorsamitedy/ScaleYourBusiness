// Phase 3 Session I — P3-41. A trading-hours signal becomes a trial in
// the queue, never a recommendation taken on faith: three scenarios with
// the arithmetic shown, nothing proposed during watching mode, one trial
// per weekday, idempotent per month; and an approved trial gets a verdict
// from the weekday's measured takings, net of the hour's cost.

import "dotenv/config";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "../../db";
import {
  accounts,
  businessProfiles,
  connections,
  fieldRecords,
  intakeEvents,
  metricObservations,
  modeDecisions,
  profileSnapshots,
  proposals,
  users,
} from "../../db/schema";
import { recordDayZero } from "../care/day-zero";
import { createField } from "../core/field";
import { fieldId } from "../core/ids";
import { isoDateTime } from "../core/iso";
import { bootstrapIntake } from "../intake/service";
import { writeField } from "../profile/field-store";
import { approveProposal } from "../proposals/service";
import { shiftDay } from "../trust/series";
import { ensureOpeningSchedule } from "./schedule";
import type { WeekdayAnalysis } from "./trading";
import { localParts } from "./trading";
import { readCurrentField } from "../profile/field-store";
import { buildTrustView } from "../trust/scorecard";
import { tradingAnalysis } from "./trading";
import {
  TRIAL,
  TRIALS_KEY,
  judgeHoursTrial,
  proposeHoursTrials,
  syncRunningTrials,
  trialFor,
  trialWindow,
} from "./trials";

const created: { account_id: string; profile_id: string }[] = [];
const ZONE = "Europe/Budapest";

async function put(profileId: string, key: string, value: unknown) {
  const at = isoDateTime(new Date().toISOString());
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
    }),
  );
}

const schedule = JSON.stringify({
  days: ["tue", "wed", "thu", "fri", "sat"].map((day) => ({
    day,
    closed: false,
    periods: [{ open: "20:00", close: "01:00" }],
    quote: "Tue–Sat 8pm–1am",
  })),
  unparsed: [],
});

function utcFor(localDate: string, localHour: number): Date {
  for (let h = 0; h < 48; h++) {
    const at = new Date(`${shiftDay(localDate, -1)}T00:00:00Z`);
    at.setUTCHours(h);
    const p = localParts(at, ZONE);
    if (p.date === localDate && p.hour === localHour) return at;
  }
  throw new Error("no such local hour");
}

/** A Budapest bar with hourly card sales; `plan(day, weekday)` gives [local hour, minor] pairs. */
async function bar(plan: (day: string, weekday: string) => [number, number][], cost = 4_000) {
  const s = await bootstrapIntake();
  created.push(s);
  const [u] = await db
    .insert(users)
    .values({
      account_id: s.account_id,
      email: `p3-41-${crypto.randomUUID()}@test.local`,
      display_name: "Bar owner",
      role: "owner",
    })
    .returning({ id: users.id });
  await put(s.profile_id, "legal.country", "Hungary");
  await put(s.profile_id, "presence.opening_hours", "Tue–Sat 8pm–1am");
  await ensureOpeningSchedule(s.profile_id, async () => ({ text: schedule, calls: [] }));
  await put(s.profile_id, "presence.open_hour_cost", { amount_minor: cost, currency: "EUR" });
  const [conn] = await db
    .insert(connections)
    .values({ account_id: s.account_id, provider: "stripe" })
    .returning({ id: connections.id });

  const today = new Date().toISOString().slice(0, 10);
  const daily = new Map<string, number>();
  const hourly = new Map<string, number>();
  for (let day = shiftDay(today, -90); day < today; day = shiftDay(day, 1)) {
    daily.set(day, daily.get(day) ?? 0);
    const weekday = localParts(new Date(`${day}T12:00:00Z`), ZONE).weekday;
    for (const [hour, value] of plan(day, weekday)) {
      const at = utcFor(hour < 5 ? shiftDay(day, 1) : day, hour);
      const utcDay = at.toISOString().slice(0, 10);
      const key = `${utcDay}|${String(at.getUTCHours()).padStart(2, "0")}`;
      hourly.set(key, (hourly.get(key) ?? 0) + value);
      daily.set(utcDay, (daily.get(utcDay) ?? 0) + value);
    }
  }
  const observed_at = new Date().toISOString();
  await db.insert(metricObservations).values([
    ...[...daily].map(([day, value]) => ({
      connection_id: conn!.id,
      provider: "stripe",
      metric_key: "revenue.daily",
      dimensions: { currency: "EUR" },
      dimension_key: '{"currency":"EUR"}',
      period_date: day,
      value_minor: value,
      currency: "EUR",
      observed_at,
    })),
    ...[...hourly].map(([key, value]) => {
      const [day, hour] = key.split("|") as [string, string];
      return {
        connection_id: conn!.id,
        provider: "stripe",
        metric_key: "revenue.hourly",
        dimensions: { currency: "EUR", hour_utc: hour },
        dimension_key: JSON.stringify({ currency: "EUR", hour_utc: hour }),
        period_date: day,
        value_minor: value,
        currency: "EUR",
        observed_at,
      };
    }),
  ]);
  return { ...s, user_id: u!.id };
}

/** Busy from the first hour on Fridays; slow first hours otherwise. */
const fridayBusy = (_day: string, weekday: string): [number, number][] =>
  weekday === "fri"
    ? [
        [20, 20_000],
        [22, 30_000],
        [0, 8_000],
      ]
    : ["tue", "wed", "thu", "sat"].includes(weekday)
      ? [
          [20, 2_000],
          [22, 10_000],
          [0, 6_000],
        ]
      : [];

afterAll(async () => {
  const ids = created.map((s) => s.profile_id);
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
  }
  if (ids.length > 0) {
    await db.delete(proposals).where(inArray(proposals.profile_id, ids));
    await db.delete(modeDecisions).where(inArray(modeDecisions.profile_id, ids));
    await db.delete(profileSnapshots).where(inArray(profileSnapshots.profile_id, ids));
    await db.delete(intakeEvents).where(inArray(intakeEvents.profile_id, ids));
    await db.delete(fieldRecords).where(inArray(fieldRecords.profile_id, ids));
  }
  for (const s of created) await db.delete(users).where(eq(users.account_id, s.account_id));
  if (ids.length > 0) await db.delete(businessProfiles).where(inArray(businessProfiles.id, ids));
  for (const s of created) await db.delete(accounts).where(eq(accounts.id, s.account_id));
});

describe("P3-41 — the scenarios are arithmetic", () => {
  const fri: WeekdayAnalysis = {
    weekday: "fri",
    days_measured: 12,
    verdict: "ok",
    curve: [
      { hour: 20, mean_minor: 20_000 },
      { hour: 22, mean_minor: 30_000 },
      { hour: 24, mean_minor: 8_000 },
    ],
    first_hour: 20,
    last_hour: 24,
    peak: { hour: 22, mean_minor: 30_000 },
    opening_signal: true,
    closing_signal: true,
    attention_signal: null,
    outside_hours_minor: 0,
    arithmetic: [],
  };
  const fmt = (m: number) => `€${(m / 100).toFixed(2)}`;
  type Scn = Record<
    "downside_case" | "base_case" | "upside_case",
    { statement: string; profit_delta_monthly: { amount_minor: number } | null; formula: string }
  > & { breakeven_condition: string };

  it("open earlier: 25/50/100% of the first hour, minus the hour's cost, over four weeks", () => {
    const t = trialFor(fri, "open_earlier", "EUR", 4_000, fmt)!;
    expect(t.summary).toBe("Open at 19:00 on Fridays for 4 weeks (a trial)");
    const s = t.scenario as Scn;
    expect(s.downside_case.profit_delta_monthly?.amount_minor).toBe((5_000 - 4_000) * TRIAL.weeks);
    expect(s.base_case.profit_delta_monthly?.amount_minor).toBe((10_000 - 4_000) * TRIAL.weeks);
    expect(s.upside_case.profit_delta_monthly?.amount_minor).toBe((20_000 - 4_000) * TRIAL.weeks);
    expect(s.base_case.formula).toContain(
      "50% × €200.00 first-hour takings − €40.00 open-hour cost",
    );
    expect(s.breakeven_condition).toContain("20% of today's first hour");
  });

  it("without the hour's cost: takings, explicitly not profit — and no closing trial at all", () => {
    const t = trialFor(fri, "open_earlier", "EUR", null, fmt)!;
    const s = t.scenario as Scn;
    expect(s.base_case.profit_delta_monthly).toBeNull();
    expect(s.base_case.statement).toContain("not profit");
    expect(trialFor(fri, "close_earlier", "EUR", null, fmt)).toBeNull();
  });

  it("close earlier: the hour's cost saved, minus 100/50/0% of the last hour lost", () => {
    const t = trialFor(fri, "close_earlier", "EUR", 4_000, fmt)!;
    expect(t.summary).toContain("Close at 00:00 after midnight on Fridays");
    const s = t.scenario as Scn;
    expect(s.downside_case.profit_delta_monthly?.amount_minor).toBe((4_000 - 8_000) * TRIAL.weeks);
    expect(s.base_case.profit_delta_monthly?.amount_minor).toBe((4_000 - 4_000) * TRIAL.weeks);
    expect(s.upside_case.profit_delta_monthly?.amount_minor).toBe(4_000 * TRIAL.weeks);
  });
});

describe("P3-41 — proposing trials", () => {
  it("a Friday opening signal becomes one pending trial; Tuesday's slow first hour does not", async () => {
    const s = await bar(fridayBusy);
    await recordDayZero(s.profile_id, crypto.randomUUID());
    const out = await proposeHoursTrials(s.profile_id);
    const summaries = out.created.map((p) => (p.action as { summary: string }).summary);
    expect(summaries).toEqual(["Open at 19:00 on Fridays for 4 weeks (a trial)"]);
    expect(out.created[0]?.status).toBe("pending");
    expect(out.created[0]?.module).toBe("hours");
    expect((out.created[0]?.action as { detail: { how: string } }).detail.how).toContain(
      "won't touch your Google listing",
    );

    // Idempotent this month, and one trial per weekday at a time.
    const again = await proposeHoursTrials(s.profile_id);
    expect(again.created).toHaveLength(0);
    expect(again.skipped.some((x) => x.reason === "already proposed this month")).toBe(true);
  });

  it("nothing is proposed before care starts or while watching (rule 15)", async () => {
    const s = await bar(fridayBusy);
    expect((await proposeHoursTrials(s.profile_id)).skipped[0]?.reason).toContain("not in care");
    await db.insert(modeDecisions).values({
      profile_id: s.profile_id,
      mode: "watching",
      watch_weeks: 6,
      inputs: {},
      reasoning: "fixture",
      confidence: "0.800",
      review_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    });
    const out = await proposeHoursTrials(s.profile_id);
    expect(out.created).toHaveLength(0);
    expect(out.skipped[0]?.reason).toContain("still watching");
  });
});

describe("P3-41 — the verdict", () => {
  it("an earlier Friday opening that took more than its cost: helped, net of the hour", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const decided = shiftDay(today, -32);
    const trialStart = shiftDay(decided, 1);
    // Before the trial: Fridays take 58 000. During it: a 19:00 hour adds 10 000.
    const s = await bar((day, weekday) => {
      const base = fridayBusy(day, weekday);
      return weekday === "fri" && day >= trialStart ? [[19, 10_000], ...base] : base;
    });
    await recordDayZero(s.profile_id, crypto.randomUUID());
    const [p] = (await proposeHoursTrials(s.profile_id)).created;
    expect(p).toBeDefined();
    await approveProposal({ proposalId: p!.id, userId: s.user_id });
    await db
      .update(proposals)
      .set({ decided_at: `${decided}T09:00:00.000Z` })
      .where(eq(proposals.id, p!.id));
    const [row] = await db.select().from(proposals).where(eq(proposals.id, p!.id));

    const v = await judgeHoursTrial(row!);
    expect(v.verdict).toBe("helped");
    // (58 000 + 10 000 − 4 000) / 58 000 = +10.3%
    expect(v.arithmetic).toContain("+10.3%");
    expect(v.arithmetic).toContain("minus the 40.00 EUR hour");
  });

  it("an extra hour that only covers its own cost did nothing", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const decided = shiftDay(today, -32);
    const trialStart = shiftDay(decided, 1);
    const s = await bar((day, weekday) => {
      const base = fridayBusy(day, weekday);
      return weekday === "fri" && day >= trialStart ? [[19, 4_000], ...base] : base;
    });
    await recordDayZero(s.profile_id, crypto.randomUUID());
    const [p] = (await proposeHoursTrials(s.profile_id)).created;
    await approveProposal({ proposalId: p!.id, userId: s.user_id });
    await db
      .update(proposals)
      .set({ decided_at: `${decided}T09:00:00.000Z` })
      .where(eq(proposals.id, p!.id));
    const [row] = await db.select().from(proposals).where(eq(proposals.id, p!.id));
    expect((await judgeHoursTrial(row!)).verdict).toBe("did_nothing");
  });

  it("the scorecard judges an approved trial, though nothing 'executed' it", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const decided = shiftDay(today, -32);
    const trialStart = shiftDay(decided, 1);
    const s = await bar((day, weekday) => {
      const base = fridayBusy(day, weekday);
      return weekday === "fri" && day >= trialStart ? [[19, 10_000], ...base] : base;
    });
    await recordDayZero(s.profile_id, crypto.randomUUID());
    const [p] = (await proposeHoursTrials(s.profile_id)).created;
    await approveProposal({ proposalId: p!.id, userId: s.user_id });
    await db
      .update(proposals)
      .set({ decided_at: `${decided}T09:00:00.000Z` })
      .where(eq(proposals.id, p!.id));

    const view = await buildTrustView(s.profile_id);
    expect(view.scorecard.outcomes.helped).toBe(1);
    const scored = view.history.find((h) => h.proposal.id === p!.id);
    expect(scored?.outcome?.verdict).toBe("helped");
    expect(scored?.outcome?.delta_pct).toBe(10.3);
    expect(scored?.outcome?.metric).toContain("Fridays");
  });

  it("a running trial is on the profile, its days are left out of the signals, and it clears when it ends", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const s = await bar(fridayBusy);
    await recordDayZero(s.profile_id, crypto.randomUUID());
    const [p] = (await proposeHoursTrials(s.profile_id)).created;
    await approveProposal({ proposalId: p!.id, userId: s.user_id });
    const decided = shiftDay(today, -15);
    await db
      .update(proposals)
      .set({ decided_at: `${decided}T09:00:00.000Z` })
      .where(eq(proposals.id, p!.id));

    const running = await syncRunningTrials(s.profile_id);
    expect(running).toEqual([
      expect.objectContaining({
        proposal_id: p!.id,
        weekday: "fri",
        change: "open_earlier",
        hour: 19,
        ...trialWindow(`${decided}T09:00:00.000Z`, 4),
      }),
    ]);
    const field = await readCurrentField<unknown[]>(s.profile_id, TRIALS_KEY);
    expect(field?.status).toBe("inferred");
    expect(field?.source).toMatchObject({ derived_from: [`proposal:${p!.id}`] });

    // Unchanged list: no new record.
    await syncRunningTrials(s.profile_id);
    const records = await db
      .select({ id: fieldRecords.id })
      .from(fieldRecords)
      .where(
        and(eq(fieldRecords.profile_id, s.profile_id), eq(fieldRecords.field_key, TRIALS_KEY)),
      );
    expect(records).toHaveLength(1);

    const analysis = await tradingAnalysis(s.profile_id);
    expect(analysis.status).toBe("ok");
    if (analysis.status === "ok") {
      const fri = analysis.weekdays.find((w) => w.weekday === "fri")!;
      expect(fri.arithmetic.some((l) => l.includes("under a running trial are left out"))).toBe(
        true,
      );
    }

    // After the trial's four weeks it clears — superseded, so the history keeps it.
    const after = new Date(Date.parse(`${decided}T09:00:00Z`) + 40 * 86_400_000);
    expect(await syncRunningTrials(s.profile_id, after)).toEqual([]);
    expect((await readCurrentField<unknown[]>(s.profile_id, TRIALS_KEY))?.value).toEqual([]);
  });

  it("two trial days are too early; a pending proposal is not judged", async () => {
    const s = await bar(fridayBusy);
    await recordDayZero(s.profile_id, crypto.randomUUID());
    const [p] = (await proposeHoursTrials(s.profile_id)).created;
    expect((await judgeHoursTrial(p!)).verdict).toBe("unmeasured");
    await approveProposal({ proposalId: p!.id, userId: s.user_id });
    const [row] = await db.select().from(proposals).where(eq(proposals.id, p!.id));
    expect((await judgeHoursTrial(row!)).verdict).toBe("too_early");
  });
});
