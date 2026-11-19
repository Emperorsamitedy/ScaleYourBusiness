// I-45a lifted (2026-11-16) — moving one opening or closing time on a Google
// listing, as the hours trials need it. Pure: no database, no network.

import { describe, expect, it } from "vitest";
import type { GbpPeriod } from "./hours";
import { changeProblem, clockWords, closeMinutes, moveEdge, readPeriods } from "./hours";

const p = (
  openDay: GbpPeriod["openDay"],
  open: number,
  closeDay: GbpPeriod["closeDay"],
  close: number,
): GbpPeriod => ({
  openDay,
  openTime: open ? { hours: open } : {},
  closeDay,
  closeTime: close ? { hours: close } : {},
});

const WEEK: GbpPeriod[] = [
  p("MONDAY", 9, "MONDAY", 17),
  p("FRIDAY", 9, "FRIDAY", 23),
  p("SATURDAY", 18, "SUNDAY", 1),
];

describe("reading Google's periods", () => {
  it("keeps valid periods, with zero values left out as Google writes them", () => {
    expect(
      readPeriods([
        { openDay: "MONDAY", openTime: {}, closeDay: "MONDAY", closeTime: { hours: 24 } },
      ]),
    ).toEqual([{ openDay: "MONDAY", openTime: {}, closeDay: "MONDAY", closeTime: { hours: 24 } }]);
  });

  it("refuses anything that isn't a period", () => {
    expect(
      readPeriods([{ openDay: "FUNDAY", openTime: {}, closeDay: "MONDAY", closeTime: {} }]),
    ).toBeNull();
    expect(
      readPeriods([
        { openDay: "MONDAY", openTime: { hours: 25 }, closeDay: "MONDAY", closeTime: {} },
      ]),
    ).toBeNull();
    expect(readPeriods(["nine to five"])).toBeNull();
  });

  it("a close at midnight reads the same either way Google writes it", () => {
    expect(closeMinutes(p("MONDAY", 9, "MONDAY", 24))).toBe(1440);
    expect(closeMinutes(p("MONDAY", 9, "TUESDAY", 0))).toBe(1440);
    expect(closeMinutes(p("SATURDAY", 18, "SUNDAY", 1))).toBe(1500);
  });
});

describe("moving one edge", () => {
  it("opens an hour earlier on the one weekday, leaving every other period as it was", () => {
    const out = moveEdge(WEEK, { weekday: "fri", edge: "open", from: 540, to: 480 });
    expect(out.kind).toBe("moved");
    if (out.kind !== "moved") return;
    expect(out.periods[1]).toEqual(p("FRIDAY", 8, "FRIDAY", 23));
    expect([out.periods[0], out.periods[2]]).toEqual([WEEK[0], WEEK[2]]);
  });

  it("closes an hour sooner past midnight, carrying the day", () => {
    const out = moveEdge(WEEK, { weekday: "sat", edge: "close", from: 1500, to: 1440 });
    expect(out.kind).toBe("moved");
    if (out.kind !== "moved") return;
    expect(out.periods[2]).toEqual(p("SATURDAY", 18, "SATURDAY", 24));
  });

  it("an edge already where it was going is 'already' — an earlier attempt landed", () => {
    expect(moveEdge(WEEK, { weekday: "fri", edge: "open", from: 600, to: 540 }).kind).toBe(
      "already",
    );
  });

  it("refuses when the listing has moved since the approval, naming the time", () => {
    const out = moveEdge(WEEK, { weekday: "mon", edge: "open", from: 600, to: 480 });
    expect(out).toEqual({
      kind: "refused",
      reason:
        "Your Google listing doesn't say you open at 10:00 on Mondays, so ScaleX didn't change it: your hours on Google have moved since this was approved.",
    });
  });

  it("refuses a day with no period, two matching periods, or a change that crosses itself", () => {
    expect(moveEdge(WEEK, { weekday: "wed", edge: "open", from: 540, to: 480 }).kind).toBe(
      "refused",
    );
    const twice = [...WEEK, p("FRIDAY", 9, "FRIDAY", 12)];
    expect(moveEdge(twice, { weekday: "fri", edge: "open", from: 540, to: 480 }).kind).toBe(
      "refused",
    );
    expect(moveEdge(WEEK, { weekday: "mon", edge: "open", from: 540, to: 1080 }).kind).toBe(
      "refused",
    );
    expect(moveEdge(WEEK, { weekday: "mon", edge: "close", from: 1020, to: 480 }).kind).toBe(
      "refused",
    );
  });

  it("refuses a change that isn't one", () => {
    expect(changeProblem({ weekday: "mon", edge: "open", from: 540, to: 540 })).not.toBeNull();
    expect(changeProblem({ weekday: "mon", edge: "open", from: 1500, to: 1440 })).not.toBeNull();
    expect(changeProblem({ weekday: "mon", edge: "close", from: -60, to: 0 })).not.toBeNull();
    expect(changeProblem({ weekday: "mon", edge: "close", from: 1500, to: 1440 })).toBeNull();
  });

  it("says the time in words", () => {
    expect(clockWords(540)).toBe("09:00");
    expect(clockWords(1440)).toBe("midnight");
    expect(clockWords(1500)).toBe("01:00 after midnight");
  });
});
