import { describe, expect, it } from "vitest";
import { trackSegs } from "./track-segs";

const word = (w: string) => w.toUpperCase();

describe("trackSegs", () => {
  it("draws the five counts in the record's order, each with its tone", () => {
    const segs = trackSegs({ inside: 5, above: 1, below: 2, cant_tell: 0, waiting: 3 }, word);
    expect(segs.map((s) => [s.key, s.label, s.value, s.tone])).toEqual([
      ["inside", "INSIDE", 5, "ok"],
      ["above", "ABOVE", 1, "ink"],
      ["below", "BELOW", 2, "alarm"],
      ["cant_tell", "CANT_TELL", 0, "soft"],
      ["waiting", "WAITING", 3, "hollow"],
    ]);
  });

  it("draws nothing when no forecast is counted", () => {
    expect(trackSegs({ inside: 0, above: 0, below: 0, cant_tell: 0, waiting: 0 }, word)).toEqual(
      [],
    );
  });
});
