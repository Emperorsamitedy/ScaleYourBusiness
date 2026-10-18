// The Trading hours week grid: which cells are open, what each nets
// against the hour's cost, the bands at their boundaries, and the
// headline's two counts.

import { describe, expect, it } from "vitest";
import type { WeekdayAnalysis } from "./trading";
import { bandOf, bestHour, isOpenHour, weekGrid } from "./grid";

function day(
  weekday: WeekdayAnalysis["weekday"],
  verdict: WeekdayAnalysis["verdict"],
  curve: { hour: number; mean_minor: number }[],
): WeekdayAnalysis {
  return {
    weekday,
    days_measured: 12,
    verdict,
    curve,
    first_hour: null,
    last_hour: null,
    peak: null,
    opening_signal: false,
    closing_signal: null,
    attention_signal: null,
    outside_hours_minor: 0,
    arithmetic: [],
  };
}

const schedule = {
  days: {
    mon: [],
    tue: [{ open: "20:00", close: "01:00" }],
    wed: [],
    thu: [],
    fri: [{ open: "20:00", close: "02:00" }],
    sat: [],
    sun: [],
  },
  unstated: ["mon" as const],
};

describe("isOpenHour", () => {
  it("covers an evening that runs past midnight, on the trading-day clock", () => {
    const p = [{ open: "20:00", close: "01:00" }];
    expect(isOpenHour(p, 20)).toBe(true);
    expect(isOpenHour(p, 24)).toBe(true); // 00:00 after midnight
    expect(isOpenHour(p, 25)).toBe(false); // closes at 01:00
    expect(isOpenHour(p, 19)).toBe(false);
  });
});

describe("bandOf", () => {
  it("reads within the even band as even, and past it either way", () => {
    expect(bandOf(500, 500)).toBe("even");
    expect(bandOf(-500, 500)).toBe("even");
    expect(bandOf(501, 500)).toBe("pays");
    expect(bandOf(-501, 500)).toBe("loses");
  });
});

describe("weekGrid", () => {
  const weekdays = [
    day("mon", "hours_unknown", []),
    day("tue", "ok", [
      { hour: 20, mean_minor: 1000 },
      { hour: 22, mean_minor: 10000 },
      { hour: 24, mean_minor: 3000 },
    ]),
    day("fri", "ok", [
      { hour: 20, mean_minor: 8000 },
      { hour: 22, mean_minor: 10000 },
      { hour: 25, mean_minor: 2000 },
    ]),
    day("sun", "closed", []),
  ];

  it("nets each open hour against its cost; an hour with no sales is a zero", () => {
    const g = weekGrid({ schedule, weekdays, hourCostMinor: 4000 });
    expect(g.hours).toEqual([20, 21, 22, 23, 24, 25]);
    const tue = g.rows.find((r) => r.weekday === "tue");
    expect(tue?.cells.map((c) => c.net_minor)).toEqual([-3000, -4000, 6000, -4000, -1000, null]);
    expect(tue?.cells.map((c) => c.band)).toEqual([
      "loses",
      "loses",
      "pays",
      "loses",
      "loses",
      null,
    ]);
    expect(g.even_within_minor).toBe(500);
  });

  it("counts the week's open hours and the ones that don't pay", () => {
    const g = weekGrid({ schedule, weekdays, hourCostMinor: 4000 });
    expect(g.open_hours).toBe(11); // Tue 5 + Fri 6
    expect(g.losing_hours).toBe(8); // Tue 4 + Fri 4
  });

  it("without a stated cost shows takings and judges nothing", () => {
    const g = weekGrid({ schedule, weekdays, hourCostMinor: null });
    const fri = g.rows.find((r) => r.weekday === "fri");
    expect(fri?.cells[0]?.takings_minor).toBe(8000);
    expect(fri?.cells.every((c) => c.net_minor === null && c.band === null)).toBe(true);
    expect(g.losing_hours).toBe(0);
  });

  it("leaves a day with unknown hours unmeasured rather than zero", () => {
    const g = weekGrid({ schedule, weekdays, hourCostMinor: 4000 });
    const mon = g.rows.find((r) => r.weekday === "mon");
    expect(mon?.cells.every((c) => c.takings_minor === null && !c.open)).toBe(true);
  });
});

describe("bestHour", () => {
  it("names the weekdays sharing the best-paying hour, and nothing when none pays", () => {
    const g = weekGrid({
      schedule,
      weekdays: [
        day("tue", "ok", [{ hour: 22, mean_minor: 10000 }]),
        day("fri", "ok", [{ hour: 22, mean_minor: 10000 }]),
      ],
      hourCostMinor: 4000,
    });
    expect(bestHour(g)).toEqual({ weekdays: ["tue", "fri"], hour: 22, net_minor: 6000 });
    const none = weekGrid({
      schedule,
      weekdays: [day("tue", "ok", [{ hour: 22, mean_minor: 100 }])],
      hourCostMinor: 4000,
    });
    expect(bestHour(none)).toBeNull();
  });
});
