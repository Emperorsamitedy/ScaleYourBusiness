// P2-22 / P2-23 — the baseline and the rule, at their boundaries.
//
// The plan's two sentences are the first two tests: a seeded 20% drop on a
// weekday fires; a normal weekend dip does not. The rest pins the constants
// so they can only change deliberately: K is strict, N is two, both
// directions fire, and too little history gives no verdict rather than a
// confident one.

import { describe, expect, it } from "vitest";
import {
  BASELINE_WINDOW_DAYS,
  MAD_K,
  MIN_BASELINE_DAYS,
  MIN_SCALE_FRACTION,
  RUN_DAYS,
  computeBaseline,
  detectRun,
  evaluateDay,
  median,
  shiftDay,
  weekOverWeek,
  weekdayOf,
} from "./baseline";

/** The fixture shop's rhythm: Saturday best, Sunday quietest. */
const WEEKDAY = [0.6, 1.0, 1.05, 1.1, 1.1, 1.2, 0.75] as const;
const BASE = 10_000;

/**
 * A steady series ending on `end`: base × weekday factor, with a small
 * deterministic wobble (±2%) so MAD is not zero unless `flat`.
 */
function steady(end: string, days = 60, flat = false): Map<string, number> {
  const out = new Map<string, number>();
  for (let i = days - 1; i >= 0; i -= 1) {
    const date = shiftDay(end, -i);
    const wobble = flat ? 1 : 1 + 0.02 * Math.sin(i * 1.7);
    out.set(date, Math.round(BASE * (WEEKDAY[weekdayOf(date)] ?? 1) * wobble));
  }
  return out;
}

/** Scale the last `n` days of a series by `factor`. */
function scaleTail(series: Map<string, number>, end: string, n: number, factor: number) {
  for (let i = 0; i < n; i += 1) {
    const d = shiftDay(end, -i);
    series.set(d, Math.round((series.get(d) ?? 0) * factor));
  }
  return series;
}

/** Set a day to exactly `sigmas` scales away from its own expected value. */
function placeAt(series: Map<string, number>, date: string, sigmas: number) {
  const b = computeBaseline(series, date);
  if (!b) throw new Error("no baseline");
  series.set(date, b.expected + sigmas * b.scale);
  return series;
}

const SUNDAY = "2026-09-13";
const TUESDAY = "2026-09-15";

describe("the plan's two sentences", () => {
  it("a seeded 20% drop on a weekday fires", () => {
    const series = scaleTail(steady(TUESDAY), TUESDAY, RUN_DAYS, 0.8);
    const run = detectRun(series, TUESDAY);
    expect(run?.direction).toBe("drop");
    expect(run?.days.map((d) => d.date)).toEqual([shiftDay(TUESDAY, -1), TUESDAY]);
    expect(run?.days.every((d) => d.pct < -0.15)).toBe(true);
  });

  it("a normal weekend dip does not", () => {
    const series = steady(SUNDAY);
    const sunday = evaluateDay(series, SUNDAY);
    expect(sunday?.beyond).toBe(false);
    // Sunday IS 40% below the weekly mean, and the weekday factor absorbs it.
    expect(sunday?.baseline.weekday_factor).toBeCloseTo(0.6, 1);
    expect(Math.abs(sunday?.pct ?? 1)).toBeLessThan(0.05);
    expect(detectRun(series, SUNDAY)).toBeNull();
  });

  it("the same 20% drop fires on a quiet Sunday as on a busy Saturday", () => {
    const sunday = scaleTail(steady(SUNDAY), SUNDAY, RUN_DAYS, 0.8);
    expect(detectRun(sunday, SUNDAY)?.direction).toBe("drop");
    const saturday = scaleTail(steady(shiftDay(SUNDAY, -1)), shiftDay(SUNDAY, -1), RUN_DAYS, 0.8);
    expect(detectRun(saturday, shiftDay(SUNDAY, -1))?.direction).toBe("drop");
  });
});

describe("P2-22 — the baseline", () => {
  it("uses the 28 days before the target, never the target itself", () => {
    const series = steady(TUESDAY);
    const b = computeBaseline(series, TUESDAY);
    expect(b?.window_from).toBe(shiftDay(TUESDAY, -BASELINE_WINDOW_DAYS));
    expect(b?.window_to).toBe(shiftDay(TUESDAY, -1));
    expect(b?.window_days).toBe(BASELINE_WINDOW_DAYS);
    expect(b?.points.some((p) => p.date === TUESDAY)).toBe(false);
  });

  it("learns each weekday's factor from the window, in proportion to the real rhythm", () => {
    const b = computeBaseline(steady(TUESDAY, 60, true), TUESDAY);
    expect(b).not.toBeNull();
    const ratios = (b?.weekday_factors ?? []).map((f, w) => f / (WEEKDAY[w] ?? 1));
    for (const r of ratios) expect(r).toBeCloseTo(ratios[0] ?? 0, 6);
    expect(b?.weekday_factors[0]).toBeLessThan(b?.weekday_factors[6] ?? 0); // Sunday < Saturday
    expect(b?.expected).toBeCloseTo((b?.overall_mean ?? 0) * (b?.weekday_factor ?? 0), 6);
  });

  it("gives no verdict without enough history", () => {
    expect(computeBaseline(steady(TUESDAY, MIN_BASELINE_DAYS), TUESDAY)).toBeNull();
    expect(computeBaseline(steady(TUESDAY, MIN_BASELINE_DAYS + 1), TUESDAY)).not.toBeNull();
    expect(evaluateDay(steady(TUESDAY, 5), TUESDAY)).toBeNull();
  });

  it("gives no verdict on a dead series", () => {
    const zeros = new Map([...steady(TUESDAY).keys()].map((d) => [d, 0]));
    expect(computeBaseline(zeros, TUESDAY)).toBeNull();
  });

  it("floors the scale at 5% of the day's expected value, so a flat series still has a unit of variation", () => {
    const b = computeBaseline(steady(TUESDAY, 60, true), TUESDAY);
    expect(b?.mad).toBe(0);
    expect(b?.scale).toBeCloseTo((b?.expected ?? 0) * MIN_SCALE_FRACTION, 6);
  });

  it("median handles odd and even counts", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBe(0);
  });
});

describe("P2-23 — the rule, at its boundaries", () => {
  it("exactly K scales is NOT beyond; a hair past it is, both ways", () => {
    for (const sign of [-1, 1]) {
      const at = placeAt(steady(TUESDAY, 60, true), TUESDAY, sign * MAD_K);
      expect(evaluateDay(at, TUESDAY)?.deviation).toBeCloseTo(sign * MAD_K, 6);
      expect(evaluateDay(at, TUESDAY)?.beyond).toBe(false);

      const past = placeAt(steady(TUESDAY, 60, true), TUESDAY, sign * (MAD_K + 0.01));
      expect(evaluateDay(past, TUESDAY)?.beyond).toBe(true);
      expect(evaluateDay(past, TUESDAY)?.direction).toBe(sign < 0 ? "drop" : "spike");
    }
  });

  it("on a flat series the boundary is K × 5% of expected: 15% either way", () => {
    const flat = steady(TUESDAY, 60, true);
    const b = computeBaseline(flat, TUESDAY);
    expect(b).not.toBeNull();
    const boundary = MAD_K * MIN_SCALE_FRACTION;
    flat.set(TUESDAY, (b?.expected ?? 0) * (1 - boundary + 0.001));
    expect(evaluateDay(flat, TUESDAY)?.beyond).toBe(false);
    flat.set(TUESDAY, (b?.expected ?? 0) * (1 - boundary - 0.001));
    expect(evaluateDay(flat, TUESDAY)?.beyond).toBe(true);
    flat.set(TUESDAY, (b?.expected ?? 0) * (1 + boundary + 0.001));
    expect(evaluateDay(flat, TUESDAY)?.direction).toBe("spike");
  });

  it("fires upward too: a spike is an anomaly", () => {
    const up = scaleTail(steady(TUESDAY, 60, true), TUESDAY, RUN_DAYS, 1.25);
    expect(detectRun(up, TUESDAY)?.direction).toBe("spike");
  });

  it("one odd day is noise; N consecutive days are a signal", () => {
    const one = scaleTail(steady(TUESDAY), TUESDAY, 1, 0.5);
    expect(evaluateDay(one, TUESDAY)?.beyond).toBe(true);
    expect(detectRun(one, TUESDAY)).toBeNull();
    const two = scaleTail(steady(TUESDAY), TUESDAY, RUN_DAYS, 0.5);
    expect(detectRun(two, TUESDAY)?.days).toHaveLength(RUN_DAYS);
  });

  it("a run must point one way", () => {
    const series = steady(TUESDAY);
    scaleTail(series, TUESDAY, 1, 0.5);
    scaleTail(series, shiftDay(TUESDAY, -1), 1, 1.6);
    expect(evaluateDay(series, TUESDAY)?.direction).toBe("drop");
    expect(evaluateDay(series, shiftDay(TUESDAY, -1))?.direction).toBe("spike");
    expect(detectRun(series, TUESDAY)).toBeNull();
  });

  it("a missing day breaks the run rather than being guessed", () => {
    const series = scaleTail(steady(TUESDAY), TUESDAY, RUN_DAYS, 0.5);
    series.delete(shiftDay(TUESDAY, -1));
    expect(detectRun(series, TUESDAY)).toBeNull();
  });
});

describe("week over week", () => {
  it("sums the last seven days against the seven before, missing days as zero", () => {
    const series = steady(TUESDAY, 60, true);
    const same = weekOverWeek(series, TUESDAY);
    expect(same.last7).toBe(same.prior7);
    expect(same.change).toBe(0);

    scaleTail(series, TUESDAY, 7, 0.6);
    expect(weekOverWeek(series, TUESDAY).change).toBeCloseTo(-0.4, 6);

    expect(weekOverWeek(new Map([[TUESDAY, 5]]), TUESDAY).change).toBeNull();
  });
});
