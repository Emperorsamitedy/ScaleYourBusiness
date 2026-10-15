// P2-30 — the trading-hours findings the report and the watch carry:
// one per signal, weekdays named Monday first, the arithmetic that fired
// it shown, `too_early` saying how many weeks remain, and nothing at all
// when no hours are stated. Pure, apart from the watch's dedupe test.

import "dotenv/config";
import { inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "../../db";
import {
  accounts,
  businessProfiles,
  fieldRecords,
  intakeEvents,
  watchActivity,
} from "../../db/schema";
import { bootstrapIntake } from "../intake/service";
import { HOURS_FINDINGS_KIND, hoursDetail, logHoursFindings, watchLog } from "../watch/job";
import { dayList, findingsSignature, tradingFindings } from "./findings";
import type { Weekday } from "./schedule";
import { WEEKDAYS } from "./schedule";
import type { TradingAnalysis, WeekdayAnalysis } from "./trading";

function day(weekday: Weekday, over: Partial<WeekdayAnalysis> = {}): WeekdayAnalysis {
  return {
    weekday,
    days_measured: 12,
    verdict: "ok",
    curve: [],
    first_hour: 20,
    last_hour: 25,
    peak: null,
    opening_signal: false,
    closing_signal: false,
    attention_signal: null,
    outside_hours_minor: 0,
    arithmetic: [],
    ...over,
  };
}

function analysis(over: Partial<Record<Weekday, Partial<WeekdayAnalysis>>>): TradingAnalysis {
  return {
    status: "ok",
    zone: "Europe/Budapest",
    currency: "EUR",
    from: "2026-07-22",
    to: "2026-10-13",
    weekdays: WEEKDAYS.map((w) => day(w, over[w] ?? { verdict: "closed" })),
    coverage: "Card sales through stripe only — cash isn't seen.",
    limit: "A closed hour records no sales…",
  };
}

const OPENING = (pct: number) =>
  `first open hour (20:00) averages 80.00 EUR, ${pct}% of the peak hour (22:00, 100.00 EUR) — the opening signal starts at 60%`;
const CLOSING =
  "last open hour (01:00 after midnight) took less than an open hour costs (40.00 EUR) on 12 of 12 days (100%) — the closing signal starts at 75%";

describe("P2-30 — findings from the analysis", () => {
  it("groups a signal's weekdays, Monday first, and carries only the line that fired it", () => {
    const block = tradingFindings(
      analysis({
        sat: { opening_signal: true, arithmetic: [OPENING(85), CLOSING] },
        fri: { opening_signal: true, arithmetic: [OPENING(80)] },
        tue: { arithmetic: [OPENING(10)] },
      }),
    );
    expect(block?.findings).toHaveLength(1);
    const [opening] = block!.findings;
    expect(opening).toMatchObject({
      signal: "opening",
      weekdays: ["fri", "sat"],
      title: "Demand probably starts before you open on Fridays and Saturdays",
    });
    expect(opening!.arithmetic).toEqual([`Fridays: ${OPENING(80)}`, `Saturdays: ${OPENING(85)}`]);
    expect(block).toMatchObject({ coverage: expect.stringContaining("cash"), currency: "EUR" });
  });

  it("closing fires only on a true closing signal — an unknown hour cost (null) is not a finding", () => {
    const block = tradingFindings(
      analysis({
        fri: { closing_signal: true, arithmetic: [CLOSING] },
        sat: {
          closing_signal: null,
          arithmetic: ["the closing check needs the cost of one open hour"],
        },
      }),
    );
    expect(block!.findings.map((f) => [f.signal, f.weekdays])).toEqual([["closing", ["fri"]]]);
    expect(block!.findings[0]!.arithmetic).toEqual([`Fridays: ${CLOSING}`]);
  });

  it("attention joins in the same shape, after opening and closing", () => {
    const block = tradingFindings(
      analysis({
        thu: {
          attention_signal: true,
          opening_signal: true,
          arithmetic: [
            OPENING(70),
            "40% of this day's website sessions … — the attention signal starts at 30%",
          ],
        },
      }),
    );
    expect(block!.findings.map((f) => f.signal)).toEqual(["opening", "attention"]);
    expect(block!.findings[1]!.arithmetic[0]).toMatch(/^Thursdays: 40% .* attention signal/);
  });

  it("too_early says how many weeks remain, and never concludes for those days", () => {
    const block = tradingFindings(
      analysis({
        mon: { verdict: "too_early", days_measured: 3, opening_signal: false },
        tue: { verdict: "too_early", days_measured: 1 },
        fri: { opening_signal: true, arithmetic: [OPENING(80)] },
      }),
    );
    const early = block!.findings.find((f) => f.signal === "too_early")!;
    expect(early.weekdays).toEqual(["mon", "tue"]);
    expect(early.title).toBe(
      "Too early to judge Mondays and Tuesdays — about 3 more weeks of measured sales",
    );
    expect(early.arithmetic).toEqual([
      "Mondays: 3 of 4 measured days",
      "Tuesdays: 1 of 4 measured days",
    ]);
    const one = tradingFindings(analysis({ wed: { verdict: "too_early", days_measured: 3 } }));
    expect(one!.findings[0]!.title).toMatch(/about 1 more week of/);
  });

  it("a signal on a too_early day is never reported", () => {
    const block = tradingFindings(
      analysis({ fri: { verdict: "too_early", days_measured: 2, opening_signal: true } }),
    );
    expect(block!.findings.map((f) => f.signal)).toEqual(["too_early"]);
  });

  it("nothing measured, or no hours stated on any day, is no block — silence never reads as fine", () => {
    expect(tradingFindings({ status: "unmeasured", reason: "no connected source" })).toBeNull();
    const unstated = analysis({});
    if (unstated.status === "ok")
      unstated.weekdays = WEEKDAYS.map((w) => day(w, { verdict: "hours_unknown" }));
    expect(tradingFindings(unstated)).toBeNull();
  });

  it("stated hours with no signal is a block with no findings — it was checked", () => {
    const block = tradingFindings(analysis({ fri: { arithmetic: [OPENING(10)] } }));
    expect(block!.findings).toEqual([]);
    expect(hoursDetail(block!, false)).toBe(
      "Trading hours checked: no signal on any measured day.",
    );
    expect(hoursDetail(block!, true)).toMatch(/no signal fires any more/);
  });

  it("dayList reads as English", () => {
    expect(dayList(["fri"])).toBe("Fridays");
    expect(dayList(["mon", "tue", "fri"])).toBe("Mondays, Tuesdays and Fridays");
  });
});

/* ── the watch: said once, said again only when the signals move ── */

const created: { account_id: string; profile_id: string }[] = [];

afterAll(async () => {
  const accountIds = created.map((s) => s.account_id);
  const profileIds = created.map((s) => s.profile_id);
  if (profileIds.length > 0) {
    await db.delete(watchActivity).where(inArray(watchActivity.profile_id, profileIds));
    await db.delete(intakeEvents).where(inArray(intakeEvents.profile_id, profileIds));
    await db.delete(fieldRecords).where(inArray(fieldRecords.profile_id, profileIds));
    await db.delete(businessProfiles).where(inArray(businessProfiles.id, profileIds));
    await db.delete(accounts).where(inArray(accounts.id, accountIds));
  }
});

describe("P2-30 — the watch logs trading-hours findings when they move", () => {
  it("logs once, stays quiet while unchanged, logs again when a weekday joins, and never on nothing measured", async () => {
    const s = await bootstrapIntake();
    created.push(s);
    const now = new Date("2026-10-14T06:00:00Z");
    const friday = analysis({ fri: { opening_signal: true, arithmetic: [OPENING(80)] } });
    const both = analysis({
      fri: { opening_signal: true, arithmetic: [OPENING(80)] },
      sat: { opening_signal: true, arithmetic: [OPENING(85)] },
    });

    expect(await logHoursFindings(s.profile_id, now, async () => friday)).toBe(true);
    expect(await logHoursFindings(s.profile_id, now, async () => friday)).toBe(false);
    expect(await logHoursFindings(s.profile_id, now, async () => both)).toBe(true);
    expect(
      await logHoursFindings(s.profile_id, now, async () => ({
        status: "unmeasured",
        reason: "x",
      })),
    ).toBe(false);
    expect(
      await logHoursFindings(s.profile_id, now, async () => {
        throw new Error("boom");
      }),
    ).toBe(false);

    const log = (await watchLog(s.profile_id)).filter((e) => e.kind === HOURS_FINDINGS_KIND);
    expect(log).toHaveLength(2);
    expect(log.map((e) => e.detail)).toContain(
      "Trading hours: Demand probably starts before you open on Fridays and Saturdays.",
    );
    const metas = log.map((e) => (e.meta as { signature: string }).signature).sort();
    expect(metas).toEqual(["opening:fri", "opening:fri,sat"]);
    expect(findingsSignature(tradingFindings(both)!)).toBe("opening:fri,sat");
  });
});
