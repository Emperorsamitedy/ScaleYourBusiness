import { describe, expect, it } from "vitest";
import { firstTight, moneyHeadline, moneyPins } from "./money-model";
import type { MoneyForecast } from "./money-model";

const week = (
  start: string,
  low: number,
  high = low + 1000,
  due?: MoneyForecast["weeks"][0]["due"],
) => ({
  start,
  balance: { low, high },
  ...(due ? { due } : {}),
});

const base = (
  weeks: MoneyForecast["weeks"],
  kind: "buffer" | "zero" = "buffer",
): MoneyForecast => ({
  today: "2026-11-23",
  currency: "EUR",
  start: { amount_minor: 90_000 },
  line: { amount_minor: kind === "buffer" ? 960_000 : 0, kind },
  weeks,
});

describe("moneyHeadline", () => {
  it("says when cash is over the buffer again after a tight week now", () => {
    const f = base([
      week("2026-11-23", 31_083),
      week("2026-11-30", 46_252),
      week("2026-12-07", 541_921),
      week("2026-12-14", 1_037_590),
    ]);
    expect(moneyHeadline(f)).toEqual({ key: "tightNow", week: "2026-12-14" });
  });

  it("says it stays under when no week drawn climbs back", () => {
    expect(moneyHeadline(base([week("2026-11-23", 1), week("2026-11-30", 2)]))).toEqual({
      key: "tightStays",
      week: null,
    });
  });

  it("names the first week that dips when this week is clear", () => {
    const f = base([week("2026-11-23", 2_000_000), week("2026-11-30", 500_000)]);
    expect(moneyHeadline(f)).toEqual({ key: "tightLater", week: "2026-11-30" });
  });

  it("is clear when no week dips, and words zero when no buffer is stated", () => {
    expect(moneyHeadline(base([week("2026-11-23", 2_000_000)])).key).toBe("clear");
    expect(moneyHeadline(base([week("2026-11-23", 5)], "zero")).key).toBe("clearZero");
    expect(moneyHeadline(base([week("2026-11-23", -5), week("2026-11-30", 5)], "zero"))).toEqual({
      key: "tightNowZero",
      week: "2026-11-30",
    });
  });
});

describe("firstTight", () => {
  it("finds the first week under the line within the weeks drawn", () => {
    const f = base([week("2026-11-23", 2_000_000), week("2026-11-30", 1)]);
    expect(firstTight(f, 8)).toBe(1);
    expect(firstTight(f, 1)).toBeNull();
  });
});

describe("moneyPins", () => {
  it("sums the bills of a day and places them along their week", () => {
    const f = base([
      week("2026-11-23", 1),
      week("2026-11-30", 1, 2, [
        { amount_minor: 145_000, on: "2026-12-01" },
        { amount_minor: 190_000, on: "2026-12-01" },
      ]),
    ]);
    const pins = moneyPins(f, 8);
    expect(pins).toHaveLength(1);
    expect(pins[0]!.amount_minor).toBe(335_000);
    expect(pins[0]!.on).toBe("2026-12-01");
    // 1 Dec is the second day of the week starting 30 Nov: two sevenths along week 1.
    expect(pins[0]!.at).toBeCloseTo(1 + 2 / 7);
  });

  it("leaves out the bills of weeks not drawn", () => {
    const f = base([
      week("2026-11-23", 1),
      week("2026-11-30", 1, 2, [{ amount_minor: 5, on: "2026-12-01" }]),
    ]);
    expect(moneyPins(f, 1)).toEqual([]);
  });
});
