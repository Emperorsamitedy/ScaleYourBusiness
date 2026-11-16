// The Watching screen's arithmetic: the day count, a signal's status and
// its first-week/last-week figures, the tally and the log's watch day.
// Each rule with a passing and a failing case.

import { describe, expect, it } from "vitest";
import { shiftDay } from "../anomaly/baseline";
import {
  REVIEW_ALERT_KIND,
  SERIES_MAX_DAYS,
  anomalySpan,
  dayOfWatch,
  notedLines,
  statusTally,
  summariseSeries,
  watchDays,
  watchSeries,
} from "./watch-view";

const NOW = new Date("2026-10-17T12:00:00Z");

describe("watchDays", () => {
  it("counts calendar days of a 4-week watch, the review date being day 28", () => {
    // Reviews on 27 Oct: day 1 is 30 Sep, so 17 Oct is day 18 of 28.
    const w = watchDays(
      { mode: "watching", watch_weeks: 4, review_at: "2026-10-27 00:00:00+00" },
      NOW,
    );
    expect(w).toEqual({
      day: 18,
      of: 28,
      start: "2026-09-30",
      end: "2026-10-27",
      days_remaining: 10,
    });
  });

  it("is null for instant mode, no decision, or a watch without weeks", () => {
    expect(
      watchDays({ mode: "instant", watch_weeks: null, review_at: "2026-10-27T00:00:00Z" }, NOW),
    ).toBeNull();
    expect(watchDays(null, NOW)).toBeNull();
    expect(
      watchDays({ mode: "watching", watch_weeks: null, review_at: "2026-10-27T00:00:00Z" }, NOW),
    ).toBeNull();
  });

  it("caps at the last day once the review date has passed, and never goes below day 1", () => {
    expect(
      watchDays({ mode: "watching", watch_weeks: 4, review_at: "2026-10-01T00:00:00Z" }, NOW)?.day,
    ).toBe(28);
    expect(
      watchDays({ mode: "watching", watch_weeks: 4, review_at: "2026-11-20T00:00:00Z" }, NOW)?.day,
    ).toBe(1);
  });
});

function series(from: string, days: number, value: (i: number) => number): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i < days; i++) m.set(shiftDay(from, i), value(i));
  return m;
}

describe("summariseSeries", () => {
  const start = "2026-09-29";

  it("is STEADY with 28 days of history and no open anomaly", () => {
    const values = series(shiftDay(start, -30), 49, () => 100);
    const s = summariseSeries({ values, watchStart: start, open: null });
    expect(s.status).toBe("steady");
    expect(s.readings).toBe(19); // 2026-09-29 .. 2026-10-17
    expect(s.first_week).toBe(100);
    expect(s.last_week).toBe(100);
  });

  it("is THIN with fewer than 14 of the last 28 days on record", () => {
    const values = series(start, 10, () => 100);
    expect(summariseSeries({ values, watchStart: start, open: null }).status).toBe("thin");
  });

  it("takes the open anomaly over the baseline: notice drifts, interrupt interrupts", () => {
    const values = series(start, 10, () => 100);
    const notice = summariseSeries({
      values,
      watchStart: start,
      open: { severity: "notice", direction: "drop", first_date: "2026-10-05" },
    });
    expect(notice.status).toBe("drifting");
    expect(notice.direction).toBe("drop");
    expect(notice.since).toBe("2026-10-05");
    const interrupt = summariseSeries({
      values,
      watchStart: start,
      open: { severity: "interrupt", direction: "drop", first_date: "2026-10-05" },
    });
    expect(interrupt.status).toBe("interrupted");
  });

  it("gives a first week only once the last seven days are a different seven", () => {
    const short = series(start, 13, (i) => (i < 7 ? 10 : 20));
    expect(summariseSeries({ values: short, watchStart: start, open: null }).first_week).toBeNull();
    const long = series(start, 14, (i) => (i < 7 ? 10 : 20));
    const s = summariseSeries({ values: long, watchStart: start, open: null });
    expect(s.first_week).toBe(10);
    expect(s.last_week).toBe(20);
  });

  it("carries the watch's days as its series, and none from before it", () => {
    const values = series(shiftDay(start, -30), 33, (i) => i);
    const s = summariseSeries({ values, watchStart: start, open: null });
    expect(s.series).toEqual([
      { date: "2026-09-29", value: 30 },
      { date: "2026-09-30", value: 31 },
      { date: "2026-10-01", value: 32 },
    ]);
  });
});

describe("watchSeries", () => {
  const start = "2026-09-29";

  it("is in date order whatever order the days were read in, a missing day as null", () => {
    const values = new Map([
      ["2026-10-02", 400],
      ["2026-09-29", 100],
      ["2026-09-30", 200],
    ]);
    expect(watchSeries(values, start)).toEqual([
      { date: "2026-09-29", value: 100 },
      { date: "2026-09-30", value: 200 },
      { date: "2026-10-01", value: null },
      { date: "2026-10-02", value: 400 },
    ]);
  });

  it("starts on the watch's first day even when the first reading came later", () => {
    const s = watchSeries(new Map([["2026-10-01", 5]]), start);
    expect(s.map((p) => p.value)).toEqual([null, null, 5]);
  });

  it("keeps only the last 42 days of a longer watch", () => {
    const s = watchSeries(
      series(start, 60, (i) => i),
      start,
    );
    expect(s).toHaveLength(SERIES_MAX_DAYS);
    expect(s[0]).toEqual({ date: shiftDay(start, 18), value: 18 });
    expect(s.at(-1)).toEqual({ date: shiftDay(start, 59), value: 59 });
  });

  it("is empty when nothing has been read since the watch began", () => {
    const before = series(shiftDay(start, -10), 5, () => 1);
    expect(watchSeries(before, start)).toEqual([]);
    expect(watchSeries(new Map(), start)).toEqual([]);
  });
});

describe("anomalySpan", () => {
  const days = watchSeries(
    series("2026-09-29", 10, () => 1),
    "2026-09-29",
  );

  it("runs from the day the anomaly began to the last day", () => {
    expect(anomalySpan(days, "2026-10-05")).toEqual([6, 9]);
  });

  it("starts at the first day when the anomaly began before the series does", () => {
    expect(anomalySpan(days, "2026-09-01")).toEqual([0, 9]);
  });

  it("is null with no open anomaly, or one that began after the last reading", () => {
    expect(anomalySpan(days, null)).toBeNull();
    expect(anomalySpan(days, "2026-10-20")).toBeNull();
    expect(anomalySpan([], "2026-10-05")).toBeNull();
  });
});

describe("statusTally", () => {
  it("names only the statuses present, steady first", () => {
    expect(statusTally([{ status: "thin" }, { status: "steady" }, { status: "steady" }])).toBe(
      "2 steady · 1 thin",
    );
    expect(statusTally([])).toBe("");
  });
});

describe("dayOfWatch", () => {
  it("numbers a log entry by its watch day, and refuses one from before the watch", () => {
    expect(dayOfWatch("2026-10-15 09:00:00+00", "2026-09-29", 28)).toBe(17);
    expect(dayOfWatch("2026-09-28T23:00:00Z", "2026-09-29", 28)).toBeNull();
  });
});

describe("notedLines (I-45b)", () => {
  const log = [
    { at: "2026-10-16 09:00:00+00", kind: REVIEW_ALERT_KIND, detail: "A 2-star review came in." },
    { at: "2026-10-15 09:00:00+00", kind: "sync_completed", detail: "Read Stripe." },
    { at: "2026-10-01 09:00:00+00", kind: "competitor_change", detail: "A price moved." },
    { at: "2026-09-01 09:00:00+00", kind: "anomaly_detected", detail: "Revenue dropped." },
  ];

  it("with no watch running, lists every noticed line, review alerts among them", () => {
    expect(notedLines(log, null).map((e) => e.kind)).toEqual([
      REVIEW_ALERT_KIND,
      "competitor_change",
      "anomaly_detected",
    ]);
  });

  it("while a watch runs, keeps only the lines on its days", () => {
    const lines = notedLines(log, { start: "2026-09-30", of: 28 });
    expect(lines.map((e) => e.kind)).toEqual([REVIEW_ALERT_KIND, "competitor_change"]);
  });

  it("never lists routine work, and stops at the limit", () => {
    expect(notedLines(log, null).map((e) => e.kind)).not.toContain("sync_completed");
    expect(notedLines(log, null, 1)).toHaveLength(1);
  });
});
