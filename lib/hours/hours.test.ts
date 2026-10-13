// Phase 2 Session F — P2-26/27/30. The opening schedule is parsed once
// and only code decides what a valid period is; the timezone follows
// from a single-zone country and is never guessed for a multi-zone one;
// the trading day runs to 05:00 so a bar night is one evening; and the
// opening and closing signals are pinned at their boundaries both ways.
// The model is a fake throughout.

import "dotenv/config";
import { eq, inArray } from "drizzle-orm";
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
import { createField } from "../core/field";
import { fieldId } from "../core/ids";
import { isoDateTime } from "../core/iso";
import { bootstrapIntake } from "../intake/service";
import { readCurrentField, writeField } from "../profile/field-store";
import { shiftDay } from "../trust/series";
import type { OpeningSchedule, ScheduleLlm } from "./schedule";
import { SCHEDULE_KEY, coerceSchedule, ensureOpeningSchedule, periodMinutes } from "./schedule";
import { KNOWN_ZONES, ensureTimezone, isValidZone, setTimezone, zoneForCountry } from "./timezone";
import {
  TRADING,
  analyseWeekday,
  attentionFor,
  localParts,
  openSpan,
  tradingAnalysis,
  tradingSlot,
} from "./trading";

const created: { account_id: string; profile_id: string }[] = [];

async function fresh() {
  const s = await bootstrapIntake();
  created.push(s);
  return s;
}

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

const barJson = JSON.stringify({
  days: [
    {
      day: "tue",
      closed: false,
      periods: [{ open: "20:00", close: "01:00" }],
      quote: "Tue–Thu 8pm–1am",
    },
    {
      day: "wed",
      closed: false,
      periods: [{ open: "20:00", close: "01:00" }],
      quote: "Tue–Thu 8pm–1am",
    },
    {
      day: "thu",
      closed: false,
      periods: [{ open: "20:00", close: "01:00" }],
      quote: "Tue–Thu 8pm–1am",
    },
    {
      day: "fri",
      closed: false,
      periods: [{ open: "20:00", close: "02:00" }],
      quote: "Fri–Sat 8pm–2am",
    },
    {
      day: "sat",
      closed: false,
      periods: [{ open: "20:00", close: "02:00" }],
      quote: "Fri–Sat 8pm–2am",
    },
    { day: "sun", closed: true, periods: [], quote: "Sun closed" },
  ],
  unparsed: ["later in summer"],
});

function fakeSchedule(text = barJson): ScheduleLlm & { calls: number } {
  const llm: ScheduleLlm = async () => {
    state.calls += 1;
    return { text, calls: [] };
  };
  const state = Object.assign(llm, { calls: 0 });
  return state;
}

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
    await db.delete(intakeEvents).where(inArray(intakeEvents.profile_id, ids));
    await db.delete(fieldRecords).where(inArray(fieldRecords.profile_id, ids));
    await db.delete(businessProfiles).where(inArray(businessProfiles.id, ids));
  }
  for (const s of created) await db.delete(accounts).where(eq(accounts.id, s.account_id));
});

describe("P2-26 — the opening schedule: parsed once, validated by code", () => {
  it("keeps valid periods, closed days and unstated days apart; an impossible time is shown, not repaired", () => {
    const schedule = coerceSchedule(
      JSON.stringify({
        days: [
          {
            day: "mon",
            closed: false,
            periods: [{ open: "25:00", close: "01:00" }],
            quote: "Mon 25pm-1am",
          },
          {
            day: "fri",
            closed: false,
            periods: [{ open: "20:00", close: "02:00" }],
            quote: "Fri 8pm–2am",
          },
          { day: "sun", closed: true, periods: [], quote: "Sun closed" },
        ],
        unparsed: [],
      }),
    );
    expect(schedule.days.fri).toEqual([{ open: "20:00", close: "02:00" }]);
    expect(schedule.days.sun).toEqual([]);
    expect(schedule.days.mon).toEqual([]);
    expect(schedule.unparsed).toEqual(["Mon 25pm-1am"]);
    // Monday's reading failed, so Monday is unknown — not closed.
    expect(schedule.unstated).toEqual(["mon", "tue", "wed", "thu", "sat"]);
    expect(() => coerceSchedule("not json")).toThrow("non-JSON");
  });

  it("a period that closes at or before it opens runs past midnight", () => {
    expect(periodMinutes({ open: "20:00", close: "01:00" })).toBe(300);
    expect(periodMinutes({ open: "09:00", close: "17:30" })).toBe(510);
    expect(openSpan([{ open: "20:00", close: "02:00" }])).toEqual({ first: 20, last: 25 });
    expect(openSpan([])).toBeNull();
  });

  it("parses once, reuses without a call, re-parses when the answer changes — with provenance", async () => {
    const s = await fresh();
    const llm = fakeSchedule();
    expect((await ensureOpeningSchedule(s.profile_id, llm)).via).toBe("no_hours");
    expect(llm.calls).toBe(0);

    await put(
      s.profile_id,
      "presence.opening_hours",
      "Tue–Thu 8pm–1am, Fri–Sat 8pm–2am, Sun closed",
    );
    const first = await ensureOpeningSchedule(s.profile_id, llm);
    expect(first.via).toBe("parsed");
    expect(first.schedule?.unparsed).toEqual(["later in summer"]);
    expect((await ensureOpeningSchedule(s.profile_id, llm)).via).toBe("reused");
    expect(llm.calls).toBe(1);

    const field = await readCurrentField<OpeningSchedule>(s.profile_id, SCHEDULE_KEY);
    expect(field?.status).toBe("inferred");
    expect(field?.source).toMatchObject({
      kind: "inferred",
      derived_from: ["presence.opening_hours"],
    });

    await put(s.profile_id, "presence.opening_hours", "Every day 6pm–2am");
    expect((await ensureOpeningSchedule(s.profile_id, llm)).via).toBe("parsed");
    expect(llm.calls).toBe(2);
  });
});

describe("P2-26 — the timezone: derived from a single-zone country, never guessed", () => {
  it("reads the country as owners type it; refuses multi-zone and unknown countries with the reason", () => {
    for (const typed of ["Hungary", "HU", "magyarország", "  hungary "]) {
      expect(zoneForCountry(typed)).toEqual({ zone: "Europe/Budapest", country: "HU" });
    }
    expect(zoneForCountry("USA")).toMatchObject({
      zone: null,
      reason: expect.stringContaining("more than one"),
    });
    expect(zoneForCountry("Spain").zone).toBeNull(); // the Canaries
    expect(zoneForCountry("Atlantis")).toMatchObject({
      zone: null,
      reason: expect.stringContaining("Atlantis"),
    });
  });

  it("every zone in the map is a real IANA zone", () => {
    for (const zone of KNOWN_ZONES) expect(isValidZone(zone), zone).toBe(true);
    expect(isValidZone("Mars/Olympus_Mons")).toBe(false);
  });

  it("writes the derived zone once, naming the country; an owner-stated zone wins", async () => {
    const s = await fresh();
    expect(await ensureTimezone(s.profile_id)).toMatchObject({ zone: null });
    await put(s.profile_id, "legal.country", "Hungary");
    expect(await ensureTimezone(s.profile_id)).toEqual({ zone: "Europe/Budapest", via: "derived" });
    expect(await ensureTimezone(s.profile_id)).toEqual({ zone: "Europe/Budapest", via: "reused" });
    const field = await readCurrentField<string>(s.profile_id, "presence.timezone");
    expect(field?.source).toMatchObject({ kind: "inferred", derived_from: ["legal.country"] });

    await put(s.profile_id, "presence.timezone", "Europe/Vienna");
    expect(await ensureTimezone(s.profile_id)).toEqual({ zone: "Europe/Vienna", via: "owner" });
  });

  it("a multi-zone business states its zone itself; a made-up zone is refused", async () => {
    const s = await fresh();
    await put(s.profile_id, "legal.country", "USA");
    expect(await ensureTimezone(s.profile_id)).toMatchObject({ zone: null });
    await setTimezone(s.profile_id, "America/Chicago");
    expect(await ensureTimezone(s.profile_id)).toEqual({ zone: "America/Chicago", via: "owner" });
    await expect(setTimezone(s.profile_id, "America/Atlantis")).rejects.toThrow("isn't a timezone");
  });
});

describe("P2-30 — the business's clock and the trading day", () => {
  it("applies the zone with its daylight saving", () => {
    expect(localParts(new Date("2026-07-03T18:00:00Z"), "Europe/Budapest")).toEqual({
      date: "2026-07-03",
      weekday: "fri",
      hour: 20,
    });
    expect(localParts(new Date("2026-01-09T19:00:00Z"), "Europe/Budapest").hour).toBe(20);
  });

  it("00:30 on Saturday is Friday night, hour 24; 05:00 starts the new day", () => {
    expect(tradingSlot({ date: "2026-07-04", weekday: "sat", hour: 0 })).toEqual({
      day: "2026-07-03",
      weekday: "fri",
      hour: 24,
    });
    expect(tradingSlot({ date: "2026-07-04", weekday: "sat", hour: 4 }).weekday).toBe("fri");
    expect(tradingSlot({ date: "2026-07-04", weekday: "sat", hour: TRADING.cutoff_hour })).toEqual({
      day: "2026-07-04",
      weekday: "sat",
      hour: 5,
    });
  });
});

describe("P2-30 — the signals, at the boundary, both directions", () => {
  const days = ["d1", "d2", "d3", "d4"];
  const fri = [{ open: "20:00", close: "02:00" }];
  const money = (m: number) => `${m}`;
  /** Every day: hour → revenue; first open hour 20, peak at 22, last hour 25. */
  const sales = (first: number, last: number[] = [5_000, 5_000, 5_000, 5_000]) =>
    new Map(
      days.map((d, i) => [
        d,
        new Map([
          [20, first],
          [21, 6_000],
          [22, 10_000],
          [25, last[i] as number],
        ]),
      ]),
    );
  const run = (first: number, last?: number[], cost: number | null = 4_000) =>
    analyseWeekday({
      weekday: "fri",
      days,
      sales: sales(first, last),
      periods: fri,
      hourCostMinor: cost,
      money,
    });

  it("a first hour at exactly 60% of the peak is the opening signal; 59.99% is not", () => {
    expect(run(6_000).opening_signal).toBe(true);
    expect(run(5_999).opening_signal).toBe(false);
    expect(run(6_000).peak).toEqual({ hour: 22, mean_minor: 10_000 });
  });

  it("the last hour under cost on 3 of 4 days (75%) is the closing signal; 2 of 4 is not", () => {
    expect(run(1_000, [3_999, 3_999, 3_999, 4_000]).closing_signal).toBe(true);
    expect(run(1_000, [3_999, 3_999, 4_000, 4_000]).closing_signal).toBe(false);
    // Exactly the cost is not under it.
    expect(run(1_000, [4_000, 4_000, 4_000, 4_000]).closing_signal).toBe(false);
  });

  it("without the cost of an open hour there is no closing verdict, and it says why", () => {
    const r = run(1_000, undefined, null);
    expect(r.closing_signal).toBeNull();
    expect(r.arithmetic).toContain("the closing check needs the cost of one open hour");
  });

  it("three measured days are too early; a closed day with sales is named; unknown hours are said", () => {
    const early = analyseWeekday({
      weekday: "fri",
      days: days.slice(0, TRADING.min_days_per_weekday - 1),
      sales: sales(6_000),
      periods: fri,
      hourCostMinor: 4_000,
      money,
    });
    expect(early.verdict).toBe("too_early");
    expect(early.opening_signal).toBe(false);

    const closed = analyseWeekday({
      weekday: "sun",
      days,
      sales: sales(1_000),
      periods: [],
      hourCostMinor: null,
      money,
    });
    expect(closed.verdict).toBe("closed");
    expect(closed.arithmetic[0]).toContain("closed on this day, yet");

    expect(
      analyseWeekday({
        weekday: "mon",
        days,
        sales: sales(1),
        periods: null,
        hourCostMinor: null,
        money,
      }).verdict,
    ).toBe("hours_unknown");
  });
});

describe("P2-29 — the attention signal, at the boundary, both directions", () => {
  const w = { first_hour: 20, verdict: "ok" as const };
  // 100 sessions on the day; `before` of them in 17:00–19:59.
  const day = (before: number) =>
    new Map([
      [17, before],
      [21, 100 - before],
    ]);

  it("30% of the day's sessions in the 3 hours before opening is the signal; 29% is not", () => {
    expect(attentionFor(w, day(30)).signal).toBe(true);
    expect(attentionFor(w, day(29)).signal).toBe(false);
    expect(attentionFor(w, day(30)).line).toContain("30% of this day's website sessions");
  });

  it("an hour earlier than the window doesn't count; fewer than 30 sessions is no verdict", () => {
    expect(
      attentionFor(
        w,
        new Map([
          [16, 50],
          [21, 50],
        ]),
      ).signal,
    ).toBe(false);
    const thin = attentionFor(w, new Map([[19, 29]]));
    expect(thin.signal).toBeNull();
    expect(thin.line).toContain("needs 30");
    expect(attentionFor({ first_hour: null, verdict: "ok" }, day(50)).signal).toBeNull();
  });
});

describe("P2-30 — end to end on a seeded bar", () => {
  /** The UTC instant whose Budapest local date and hour are the ones given. */
  function utcFor(localDate: string, localHour: number): Date {
    for (let h = -4; h <= 28; h++) {
      const at = new Date(`${shiftDay(localDate, -1)}T00:00:00Z`);
      at.setUTCHours(at.getUTCHours() + 24 + h);
      const p = localParts(at, "Europe/Budapest");
      if (p.date === localDate && p.hour === localHour) return at;
    }
    throw new Error("no such local hour");
  }

  it("Friday's first hour is busy (opening signal), Tuesday's isn't; coverage is stated", async () => {
    const s = await fresh();
    await put(s.profile_id, "legal.country", "Hungary");
    await put(
      s.profile_id,
      "presence.opening_hours",
      "Tue–Thu 8pm–1am, Fri–Sat 8pm–2am, Sun closed",
    );
    await ensureOpeningSchedule(s.profile_id, fakeSchedule());
    await put(s.profile_id, "presence.open_hour_cost", { amount_minor: 4_000, currency: "EUR" });
    const [conn] = await db
      .insert(connections)
      .values({ account_id: s.account_id, provider: "stripe" })
      .returning({ id: connections.id });

    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const rows = [];
    const daily = new Map<string, number>();
    const hourly = new Map<string, number>();
    for (let day = shiftDay(today, -TRADING.window_days); day < today; day = shiftDay(day, 1)) {
      daily.set(day, daily.get(day) ?? 0);
      const weekday = localParts(new Date(`${day}T12:00:00Z`), "Europe/Budapest").weekday;
      const plan: [number, number][] =
        weekday === "fri"
          ? [
              [20, 8_000],
              [22, 10_000],
              [25, 2_000],
            ]
          : weekday === "tue"
            ? [
                [20, 1_000],
                [22, 10_000],
                [24, 3_000],
              ]
            : [];
      for (const [hour, value] of plan) {
        const localDate = hour >= 24 ? shiftDay(day, 1) : day;
        const at = utcFor(localDate, hour % 24);
        const utcDay = at.toISOString().slice(0, 10);
        const key = `${utcDay}|${String(at.getUTCHours()).padStart(2, "0")}`;
        hourly.set(key, (hourly.get(key) ?? 0) + value);
        daily.set(utcDay, (daily.get(utcDay) ?? 0) + value);
      }
    }
    for (const [day, value] of daily) {
      rows.push({
        connection_id: conn!.id,
        provider: "stripe",
        metric_key: "revenue.daily",
        dimensions: { currency: "EUR" },
        dimension_key: '{"currency":"EUR"}',
        period_date: day,
        value_minor: value,
        currency: "EUR",
        observed_at: now.toISOString(),
      });
    }
    for (const [key, value] of hourly) {
      const [day, hour] = key.split("|") as [string, string];
      rows.push({
        connection_id: conn!.id,
        provider: "stripe",
        metric_key: "revenue.hourly",
        dimensions: { currency: "EUR", hour_utc: hour },
        dimension_key: JSON.stringify({ currency: "EUR", hour_utc: hour }),
        period_date: day,
        value_minor: value,
        currency: "EUR",
        observed_at: now.toISOString(),
      });
    }
    await db.insert(metricObservations).values(rows);

    const result = await tradingAnalysis(s.profile_id, now);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.zone).toBe("Europe/Budapest");
    expect(result.coverage).toContain("stripe");
    expect(result.coverage).toContain("cash");

    const friday = result.weekdays.find((w) => w.weekday === "fri")!;
    expect(friday.verdict).toBe("ok");
    expect(friday.opening_signal).toBe(true); // 8 000 of a 10 000 peak
    expect(friday.closing_signal).toBe(true); // the 01:00 hour takes 2 000 against a 4 000 cost
    const tuesday = result.weekdays.find((w) => w.weekday === "tue")!;
    expect(tuesday.opening_signal).toBe(false); // 1 000 of 10 000
    expect(tuesday.curve.find((c) => c.hour === 24)?.mean_minor).toBe(3_000); // midnight stays Tuesday
    expect(result.weekdays.find((w) => w.weekday === "mon")!.verdict).toBe("hours_unknown");
    expect(result.weekdays.find((w) => w.weekday === "sun")!.verdict).toBe("closed");
  });

  it("a multi-zone country gets no analysis, with the reason", async () => {
    const s = await fresh();
    await put(s.profile_id, "legal.country", "USA");
    expect(await tradingAnalysis(s.profile_id)).toMatchObject({
      status: "unmeasured",
      reason: expect.stringContaining("more than one timezone"),
    });
  });
});
