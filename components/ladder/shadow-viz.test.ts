import { describe, expect, it } from "vitest";
import { gainLoss, shadowSegs } from "./shadow-viz";

const word = (o: string) => o;
const eur = (amount_minor: number) => ({ amount_minor, currency: "EUR" });
const huf = (amount_minor: number) => ({ amount_minor, currency: "HUF" });

describe("shadowSegs", () => {
  it("draws the five outcomes in the summary's order, each with its tone", () => {
    const segs = shadowSegs(
      {
        gained: { count: 9, total: [eur(214_000)] },
        nothing: 3,
        lost: { count: 2, total: [eur(-31_000)] },
        unproven: 0,
        still_open: 4,
      },
      word,
    );
    expect(segs.map((s) => [s.key, s.value, s.tone])).toEqual([
      ["gained", 9, "ok"],
      ["nothing", 3, "soft"],
      ["lost", 2, "alarm"],
      ["unproven", 0, "faint"],
      ["open", 4, "hollow"],
    ]);
  });

  it("draws nothing when nothing is counted", () => {
    expect(
      shadowSegs(
        {
          gained: { count: 0, total: [] },
          nothing: 0,
          lost: { count: 0, total: [] },
          unproven: 0,
          still_open: 0,
        },
        word,
      ),
    ).toEqual([]);
  });
});

describe("gainLoss", () => {
  it("pairs gained with lost per currency on that currency's own scale", () => {
    expect(gainLoss([eur(214_000), huf(5_000_000)], [eur(-31_000)])).toEqual([
      { currency: "EUR", gained: eur(214_000), lost: eur(-31_000), max: 214_000 },
      { currency: "HUF", gained: huf(5_000_000), lost: huf(0), max: 5_000_000 },
    ]);
  });

  it("gives nothing to draw with no money, or only zeros", () => {
    expect(gainLoss([], [])).toEqual([]);
    expect(gainLoss([eur(0)], [eur(0)])).toEqual([]);
  });
});
