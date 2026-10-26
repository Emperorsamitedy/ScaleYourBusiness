import { describe, expect, it } from "vitest";
import {
  SEASONS,
  addDays,
  completeWeeks,
  mondayOf,
  normalOver,
  quantile,
  ratioOf,
  ratioText,
  seasonForecast,
} from "./forecast";
import type { SeriesInfo } from "./forecast";

const INFO: SeriesInfo = { noun: "revenue", source: "Shopify", currency: "EUR" };

/** A daily series from `from` to `to` inclusive. */
function series(from: string, to: string, f: (day: string) => number): Map<string, number> {
  const m = new Map<string, number>();
  for (let d = from; d <= to; d = addDays(d, 1)) m.set(d, f(d));
  return m;
}

// Monday 2026-10-26 is "today" throughout: this week starts today.
const TODAY = "2026-10-26";
const YESTERDAY = "2026-10-25";

describe("week arithmetic", () => {
  it("finds the Monday on or before a day", () => {
    expect(mondayOf("2026-10-26")).toBe("2026-10-26");
    expect(mondayOf("2026-11-01")).toBe("2026-10-26"); // a Sunday
    expect(mondayOf("2026-10-25")).toBe("2026-10-19");
  });

  it("counts a week only when all seven days were measured", () => {
    const s = series("2026-10-05", "2026-10-25", () => 10);
    expect(completeWeeks(s, YESTERDAY).get("2026-10-12")).toBe(70);
    s.delete("2026-10-14"); // one unmeasured Wednesday
    const weeks = completeWeeks(s, YESTERDAY);
    expect(weeks.has("2026-10-12")).toBe(false);
    expect(weeks.get("2026-10-19")).toBe(70);
  });

  it("interpolates quantiles like a spreadsheet", () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([1, 2, 3, 4], 0.25)).toBeCloseTo(1.75);
    expect(quantile([], 0.5)).toBe(0);
  });
});

describe("the seasonal index", () => {
  it("is a week's value over the median week, ranged by the middle half", () => {
    const weeks = new Map([
      ["2026-01-05", 600],
      ["2026-01-12", 700],
      ["2026-01-19", 800],
      ["2026-01-26", 900],
    ]);
    const n = normalOver(weeks, "2026-01-01", "2026-02-01")!;
    expect(n.median).toBe(750);
    expect(n.p25).toBe(675);
    expect(n.p75).toBe(825);
    const r = ratioOf(1500, 1, n);
    expect(r.index).toBeCloseTo(2);
    expect(r.low).toBeCloseTo(1500 / 825);
    expect(r.high).toBeCloseTo(1500 / 675);
    expect(ratioText(r)).toBe("2.0× (1.8–2.2×)");
  });

  it("has no upper bound when a quarter of the weeks were zero", () => {
    const weeks = new Map([
      ["2026-01-05", 0],
      ["2026-01-12", 0],
      ["2026-01-19", 800],
      ["2026-01-26", 900],
    ]);
    const n = normalOver(weeks, "2026-01-01", "2026-02-01")!;
    expect(ratioOf(800, 1, n).high).toBeNull();
  });
});

/** A year (and a bit) at 100 a day, with a busy stretch and a quiet one. */
function shopYear(
  opts: { from?: string; busy?: [string, string, number]; quiet?: [string, string, number] } = {},
) {
  const busy = opts.busy ?? ["2025-11-24", "2025-12-21", 2]; // 4 weeks at 2×
  const quiet = opts.quiet ?? ["2026-01-05", "2026-02-01", 0.5]; // 4 weeks at half
  return series(opts.from ?? "2025-10-20", YESTERDAY, (d) => {
    if (d >= busy[0] && d <= busy[1]) return 100 * busy[2];
    if (d >= quiet[0] && d <= quiet[1]) return 100 * quiet[2];
    return 100;
  });
}

describe("the not-enough-history refusal", () => {
  it("refuses with under a year, and says how much there is and what it can't say", () => {
    const s = series("2026-04-01", YESTERDAY, () => 100);
    const r = seasonForecast(s, INFO, TODAY);
    expect(r.status).toBe("too_little");
    if (r.status !== "too_little") return;
    expect(r.covered_days).toBe(208);
    expect(r.complete_weeks).toBeLessThan(SEASONS.min_weeks);
    expect(r.headline).toMatch(/about 6 months of your revenue/);
    expect(r.cannot.join(" ")).toMatch(/industry average/);
    expect(r.recent.length).toBe(SEASONS.recent_weeks);
    expect(r.ready_on > TODAY).toBe(true);
  });

  it("answers once 50 of the last 52 weeks are complete", () => {
    const s = shopYear();
    const r = seasonForecast(s, INFO, TODAY);
    expect(r.status).toBe("ready");
  });

  it("holds the line at 49 complete weeks", () => {
    const s = shopYear();
    // Break three weeks of the trailing year: one missing day each.
    for (const d of ["2026-03-04", "2026-05-06", "2026-07-08"]) s.delete(d);
    expect(seasonForecast(s, INFO, TODAY).status).toBe("too_little");
    s.set("2026-07-08", 100); // back to two broken weeks: 50 complete
    const r = seasonForecast(s, INFO, TODAY);
    expect(r.status).toBe("ready");
    if (r.status === "ready") expect(r.notes.join(" ")).toMatch(/2 weeks of the last 52/);
  });

  it("says so when a long history stopped, rather than calling it short", () => {
    const s = series("2024-06-03", "2026-03-01", () => 100);
    const r = seasonForecast(s, INFO, TODAY);
    expect(r.status).toBe("too_little");
    if (r.status === "too_little") expect(r.headline).toMatch(/last measured day is 1 Mar/);
  });

  it("refuses when the normal week is zero", () => {
    const s = series("2025-10-20", YESTERDAY, (d) => (d.endsWith("-01") ? 500 : 0));
    const r = seasonForecast(s, INFO, TODAY);
    expect(r.status).toBe("too_little");
    if (r.status === "too_little") expect(r.headline).toMatch(/no normal week/);
  });

  it("has nothing to say about nothing", () => {
    expect(seasonForecast(new Map(), INFO, TODAY).status).toBe("no_data");
  });
});

describe("seasons in the last year", () => {
  it("names a busy and a quiet stretch with their index", () => {
    const r = seasonForecast(shopYear(), INFO, TODAY);
    if (r.status !== "ready") throw new Error(r.status);
    expect(r.normal.median).toBe(700);
    const busy = r.runs.find((x) => x.kind === "busy")!;
    expect(busy.start).toBe("2025-11-24");
    expect(busy.end).toBe("2025-12-21");
    expect(busy.weeks).toBe(4);
    expect(busy.index).toBeCloseTo(2);
    const quiet = r.runs.find((x) => x.kind === "quiet")!;
    expect(quiet.index).toBeCloseTo(0.5);
    // Months: December's first three weeks are busy, so December reads above.
    const dec = r.months.find((m) => m.month === "2025-12")!;
    expect(dec.index).toBeGreaterThan(1.25);
    const jun = r.months.find((m) => m.month === "2026-06")!;
    expect(jun.index).toBeCloseTo(1);
  });

  it("doesn't call one high week a season", () => {
    const s = shopYear({ busy: ["2026-03-02", "2026-03-08", 3] });
    const r = seasonForecast(s, INFO, TODAY);
    if (r.status !== "ready") throw new Error(r.status);
    expect(r.weeks.find((w) => w.start === "2026-03-02")?.flag).toBe("busy");
    expect(r.runs.some((x) => x.kind === "busy")).toBe(false);
  });

  it("doesn't flag 1.2× (below the busy line) but does 1.25×", () => {
    const low = seasonForecast(shopYear({ busy: ["2026-03-02", "2026-03-22", 1.2] }), INFO, TODAY);
    const at = seasonForecast(shopYear({ busy: ["2026-03-02", "2026-03-22", 1.25] }), INFO, TODAY);
    if (low.status !== "ready" || at.status !== "ready") throw new Error("not ready");
    expect(low.runs.some((x) => x.kind === "busy")).toBe(false);
    expect(at.runs.some((x) => x.kind === "busy")).toBe(true);
  });
});

describe("the year-over-year window", () => {
  it("sets the next eight weeks beside the same weeks 364 days before", () => {
    const r = seasonForecast(shopYear(), INFO, TODAY);
    if (r.status !== "ready") throw new Error(r.status);
    expect(r.ahead).toHaveLength(SEASONS.horizon_weeks);
    expect(r.ahead[0]!.start).toBe("2026-10-26");
    expect(r.ahead[0]!.last_year_start).toBe("2025-10-27");
    expect(addDays(r.ahead[0]!.last_year_start, 364)).toBe(r.ahead[0]!.start);
    // Week 5 (from 23 Nov this year) lines up with last year's 24 Nov: busy.
    expect(r.ahead[4]!.last_year_start).toBe("2025-11-24");
    expect(r.ahead[4]!.flag).toBe("busy");
    expect(r.ahead[3]!.flag).toBeNull();
  });

  it("says a busy stretch last year starts in N weeks this year", () => {
    const r = seasonForecast(shopYear(), INFO, TODAY);
    if (r.status !== "ready") throw new Error(r.status);
    expect(r.upcoming).toHaveLength(1);
    const u = r.upcoming[0]!;
    expect(u.starts_in_weeks).toBe(4);
    expect(u.starts_on).toBe("2026-11-23");
    expect(u.sentence).toBe(
      "The 4 weeks from 24 Nov to 21 Dec last year ran 2.0× your normal week — above it. The same weeks this year start in 4 weeks, on 23 Nov.",
    );
    expect(r.headline).toMatch(/busy stretch starts in 4 weeks/);
  });

  it("leaves out a stretch beyond the eight weeks", () => {
    const s = shopYear({
      busy: ["2026-02-02", "2026-02-22", 2],
      quiet: ["2026-05-04", "2026-05-31", 0.5],
    });
    const r = seasonForecast(s, INFO, TODAY);
    if (r.status !== "ready") throw new Error(r.status);
    expect(r.runs.some((x) => x.kind === "busy")).toBe(true);
    expect(r.upcoming).toHaveLength(0);
    expect(r.headline).toMatch(/Nothing busy in the next 8 weeks/);
  });

  it("says when the stretch is already under way", () => {
    const s = shopYear({ busy: ["2025-10-20", "2025-11-09", 2] });
    const r = seasonForecast(s, INFO, TODAY);
    if (r.status !== "ready") throw new Error(r.status);
    const u = r.upcoming.find((x) => x.run.kind === "busy")!;
    expect(u.in_progress).toBe(true);
    expect(u.starts_in_weeks).toBe(0);
    expect(u.sentence).toMatch(/under way now/);
  });

  it("marks a week last year that wasn't measured in full as unknown, not zero", () => {
    const s = shopYear();
    s.delete("2025-11-05");
    const r = seasonForecast(s, INFO, TODAY);
    if (r.status !== "ready") throw new Error(r.status);
    expect(r.ahead[1]!.last_year).toBeNull();
    expect(r.ahead[1]!.flag).toBeNull();
  });

  it("widens the range with a second year, each year against its own normal", () => {
    // Two years at 100 a day; the busy stretch ran 2× last year and 1.6× the year before.
    const s = series("2024-10-21", YESTERDAY, (d) => {
      if (d >= "2025-11-24" && d <= "2025-12-21") return 200;
      if (d >= "2024-11-25" && d <= "2024-12-22") return 160;
      return 100;
    });
    const r = seasonForecast(s, INFO, TODAY);
    if (r.status !== "ready") throw new Error(r.status);
    expect(r.years).toBe(2);
    const busy = r.runs.find((x) => x.kind === "busy")!;
    expect(busy.index).toBeCloseTo(2);
    expect(busy.low).toBeCloseTo(1.6);
    expect(busy.high).toBeCloseTo(2);
    expect(ratioText(busy)).toBe("2.0× (1.6–2.0×)");
  });
});
