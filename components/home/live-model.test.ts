import { describe, expect, it } from "vitest";
import { change, fillOf, livePoints, liveScale, pathOf, splitAtBaseline } from "./live-model";

const MIN = 60_000;
const readAt = Date.parse("2026-11-16T12:00:30Z");

describe("livePoints", () => {
  const minutes = [
    { minutes_ago: 29, active: 2 },
    { minutes_ago: 14, active: 5 },
    { minutes_ago: 0, active: 9 },
  ];

  it("places each minute back from the read, oldest first", () => {
    expect(livePoints(minutes, readAt, readAt, 30)).toEqual([
      { at: readAt - 29 * MIN, value: 2 },
      { at: readAt - 14 * MIN, value: 5 },
      { at: readAt, value: 9 },
    ]);
  });

  it("keeps only the minutes inside the window, which slides on with the clock", () => {
    expect(livePoints(minutes, readAt, readAt, 15).map((p) => p.value)).toEqual([5, 9]);
    expect(livePoints(minutes, readAt, readAt + 2 * MIN, 15).map((p) => p.value)).toEqual([9]);
  });
});

describe("liveScale", () => {
  it("frames the line with room above and below, never under zero, on whole-person ticks", () => {
    const s = liveScale([3, 12, 7]);
    expect(s.lo).toBeGreaterThanOrEqual(0);
    expect(s.lo).toBeLessThan(3);
    expect(s.hi).toBeGreaterThan(12);
    expect(s.ticks.length).toBeGreaterThan(1);
    expect(s.ticks.every((t) => Number.isInteger(t) && t >= s.lo && t <= s.hi)).toBe(true);
  });

  it("gives a flat or empty line a usable scale", () => {
    expect(liveScale([0, 0]).hi).toBeGreaterThan(0);
    expect(liveScale([]).hi).toBeGreaterThan(0);
  });
});

describe("splitAtBaseline", () => {
  it("cuts the line where it crosses: above is up, below is down, the cut on the baseline", () => {
    const s = splitAtBaseline(
      [
        { x: 0, y: 50 },
        { x: 10, y: 30 },
        { x: 20, y: 70 },
        { x: 30, y: 60 },
      ],
      50,
    );
    expect(s.up).toEqual([
      [
        { x: 0, y: 50 },
        { x: 10, y: 30 },
        { x: 15, y: 50 },
      ],
    ]);
    expect(s.down).toEqual([
      [
        { x: 15, y: 50 },
        { x: 20, y: 70 },
        { x: 30, y: 60 },
      ],
    ]);
  });

  it("keeps a line that never crosses on one side, and has nothing for no points", () => {
    expect(
      splitAtBaseline(
        [
          { x: 0, y: 10 },
          { x: 5, y: 20 },
        ],
        40,
      ).down,
    ).toEqual([]);
    expect(splitAtBaseline([], 40)).toEqual({ up: [], down: [] });
  });

  it("draws each run and closes its fill to the baseline", () => {
    const runs = [
      [
        { x: 0, y: 40 },
        { x: 10, y: 20 },
      ],
    ];
    expect(pathOf(runs)).toBe("M0.0 40.0L10.0 20.0");
    expect(fillOf(runs, 40)).toBe("M0.0 40.0L10.0 20.0L10.0 40.0L0.0 40.0Z");
  });
});

describe("change", () => {
  it("is the difference from the window's first reading, and its share when that is not zero", () => {
    expect(change(8, 10)).toEqual({ diff: 2, share: 0.25 });
    expect(change(10, 6)).toEqual({ diff: -4, share: -0.4 });
    expect(change(0, 3)).toEqual({ diff: 3, share: null });
  });
});
