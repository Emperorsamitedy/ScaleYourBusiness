import { describe, expect, it } from "vitest";
import type { DayPoint } from "./candles";
import { BUCKETS, BUCKET_SPAN, bucketCandles, bucketStart, lastBuckets } from "./candles";

// Two weeks and a bit, hand-picked: Mon 2026-09-28 .. Sun 2026-10-11, plus
// Mon 2026-10-12. September ends inside the first week, so the month
// bucket splits it.
const P = (date: string, value_minor: number, volume: number | null = null): DayPoint => ({
  date,
  value_minor,
  volume,
});
const DAYS: DayPoint[] = [
  P("2026-09-28", 1000, 4), // Mon
  P("2026-09-29", 1400, 6),
  P("2026-09-30", 800, 2), // last of September
  P("2026-10-01", 1200, 5),
  // 2026-10-02 missing: a gap, never a zero
  P("2026-10-03", 900, null), // volume not measured
  P("2026-10-04", 1100, 3), // Sun
  P("2026-10-05", 700, 1), // Mon, week 2
  P("2026-10-06", 1500, 7),
  P("2026-10-11", 1300, 4), // Sun
  P("2026-10-12", 600, 2), // Mon, week 3
];

describe("bucketStart", () => {
  it("is the day, the Monday, or the first of the month", () => {
    expect(bucketStart("2026-10-04", "day")).toBe("2026-10-04");
    expect(bucketStart("2026-10-04", "week")).toBe("2026-09-28"); // Sunday → its Monday
    expect(bucketStart("2026-09-28", "week")).toBe("2026-09-28");
    expect(bucketStart("2026-10-04", "month")).toBe("2026-10-01");
  });
});

describe("bucketCandles — OHLC by hand", () => {
  it("1D: every measured day is a candle from the day before's value to its own", () => {
    const c = bucketCandles(DAYS, "day");
    expect(c).toHaveLength(DAYS.length);
    // The first day has nothing before it: a flat candle.
    expect(c[0]).toMatchObject({
      open_minor: 1000,
      close_minor: 1000,
      high_minor: 1000,
      low_minor: 1000,
    });
    expect(c[1]).toMatchObject({
      start: "2026-09-29",
      open_minor: 1000,
      high_minor: 1400,
      low_minor: 1000,
      close_minor: 1400,
      days: 1,
      volume: 6,
    });
    // Over the gap: 10-03 opens at 10-01's value, the last one measured.
    expect(c.find((x) => x.start === "2026-10-03")).toMatchObject({
      open_minor: 1200,
      close_minor: 900,
      high_minor: 1200,
      low_minor: 900,
    });
    expect(c.find((x) => x.start === "2026-10-02")).toBeUndefined();
    expect(c.find((x) => x.start === "2026-10-03")?.volume).toBeNull();
  });

  it("1W: open = first day, close = last day, high/low = best/worst day", () => {
    const c = bucketCandles(DAYS, "week");
    expect(c.map((x) => x.start)).toEqual(["2026-09-28", "2026-10-05", "2026-10-12"]);
    expect(c[0]).toMatchObject({
      first: "2026-09-28",
      last: "2026-10-04",
      open_minor: 1000,
      high_minor: 1400,
      low_minor: 800,
      close_minor: 1100,
      days: 6,
      volume: 4 + 6 + 2 + 5 + 3, // the unmeasured day adds nothing
    });
    expect(c[1]).toMatchObject({
      open_minor: 700,
      high_minor: 1500,
      low_minor: 700,
      close_minor: 1300,
      days: 3,
      volume: 12,
    });
    expect(c[2]).toMatchObject({ open_minor: 600, close_minor: 600, days: 1 });
  });

  it("1M: calendar months, split inside a week", () => {
    const c = bucketCandles(DAYS, "month");
    expect(c.map((x) => x.start)).toEqual(["2026-09-01", "2026-10-01"]);
    expect(c[0]).toMatchObject({
      open_minor: 1000,
      high_minor: 1400,
      low_minor: 800,
      close_minor: 800,
      days: 3,
      volume: 12,
    });
    expect(c[1]).toMatchObject({
      open_minor: 1200,
      high_minor: 1500,
      low_minor: 600,
      close_minor: 600,
      days: 7,
    });
  });

  it("reads days in date order whatever order they arrive in", () => {
    const shuffled = [...DAYS].reverse();
    expect(bucketCandles(shuffled, "week")).toEqual(bucketCandles(DAYS, "week"));
  });

  it("a bucket with no measured volume at all has null volume, not zero", () => {
    const c = bucketCandles([P("2026-10-05", 100), P("2026-10-06", 200)], "week");
    expect(c[0]?.volume).toBeNull();
  });

  it("an empty series has no candles", () => {
    expect(bucketCandles([], "week")).toEqual([]);
  });

  it("skips a value that is not integer minor units", () => {
    const c = bucketCandles([P("2026-10-05", 100.5), P("2026-10-06", 200)], "day");
    expect(c.map((x) => x.start)).toEqual(["2026-10-06"]);
  });
});

describe("the overlay rides on the buckets", () => {
  const slipped: DayPoint[] = [
    { ...P("2026-10-05", 1000), slip: [{ key: "no_shows", low_minor: 80, high_minor: 90 }] },
    {
      ...P("2026-10-06", 1200),
      slip: [
        { key: "no_shows", low_minor: 40, high_minor: 45 },
        { key: "revenue_dips", low_minor: 0, high_minor: 25 },
      ],
    },
    P("2026-10-07", 1100),
  ];

  it("sums each component over the bucket and keeps only those that slipped", () => {
    const [w] = bucketCandles(slipped, "week");
    expect(w!.slip).toEqual([
      { key: "no_shows", low_minor: 120, high_minor: 135 },
      { key: "revenue_dips", low_minor: 0, high_minor: 25 },
    ]);
    expect(w!.slip_low_minor).toBe(120);
    expect(w!.slip_high_minor).toBe(160);
  });

  it("puts the kept line above the close by the average slip per measured day, in whole minor units", () => {
    const [w] = bucketCandles(slipped, "week");
    // close 1100; 120 ÷ 3 = 40; 160 ÷ 3 = 53.33 → 53
    expect(w!.kept_low_minor).toBe(1140);
    expect(w!.kept_high_minor).toBe(1153);
    expect(Number.isInteger(w!.kept_high_minor)).toBe(true);
  });

  it("a day with nothing slipped keeps the line on the close", () => {
    const d = bucketCandles(slipped, "day");
    expect(d[2]).toMatchObject({ kept_low_minor: 1100, kept_high_minor: 1100, slip: [] });
    expect(d[1]).toMatchObject({ open_minor: 1000, close_minor: 1200 });
    expect(d[0]).toMatchObject({ kept_low_minor: 1080, kept_high_minor: 1090 });
  });

  it("every money figure is an integer and every range is ordered", () => {
    for (const b of BUCKETS) {
      for (const c of bucketCandles(slipped, b)) {
        for (const v of [c.open_minor, c.close_minor, c.kept_low_minor, c.kept_high_minor]) {
          expect(Number.isSafeInteger(v)).toBe(true);
        }
        expect(c.slip_low_minor).toBeLessThanOrEqual(c.slip_high_minor);
        expect(c.kept_low_minor).toBeLessThanOrEqual(c.kept_high_minor);
        expect(c.low_minor).toBeLessThanOrEqual(Math.min(c.open_minor, c.close_minor));
        expect(c.high_minor).toBeGreaterThanOrEqual(Math.max(c.open_minor, c.close_minor));
      }
    }
  });
});

describe("closed days", () => {
  it("a day with nothing taken and nothing sold prints no candle, and is counted", () => {
    const week: DayPoint[] = [
      P("2026-10-05", 0, 0), // Monday, closed
      P("2026-10-06", 900, 9),
      P("2026-10-07", 1200, 12),
      P("2026-10-11", 0, 0), // Sunday, closed
    ];
    const [w] = bucketCandles(week, "week");
    expect(w).toMatchObject({
      open_minor: 900,
      close_minor: 1200,
      low_minor: 900,
      days: 2,
      closed: 2,
    });
    const d = bucketCandles(week, "day");
    expect(d.map((x) => x.start)).toEqual(["2026-10-06", "2026-10-07"]);
  });

  it("a zero price with an unmeasured volume is still a trading day: it can't be told from a bad one", () => {
    const [w] = bucketCandles([P("2026-10-06", 900, null), P("2026-10-07", 0, null)], "week");
    expect(w).toMatchObject({ close_minor: 0, low_minor: 0, days: 2, closed: 0 });
  });
});

describe("lastBuckets and the span", () => {
  it("keeps the newest n", () => {
    const c = bucketCandles(DAYS, "day");
    expect(lastBuckets(c, 2).map((x) => x.start)).toEqual(["2026-10-11", "2026-10-12"]);
    expect(lastBuckets(c, 99)).toHaveLength(c.length);
  });

  it("a phone shows fewer buckets than the full width, for every bucket", () => {
    for (const b of BUCKETS) {
      expect(BUCKET_SPAN[b].narrow).toBeLessThan(BUCKET_SPAN[b].wide);
      expect(BUCKET_SPAN[b].narrow).toBeGreaterThan(0);
    }
  });
});
