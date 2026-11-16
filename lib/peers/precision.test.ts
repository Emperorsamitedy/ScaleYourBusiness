// D90: the floor protects privacy, not precision — a comparison that rests
// on few businesses, or on a widened cohort, says it is a rough guide.

import { describe, expect, it } from "vitest";
import { PRECISION_FAIR_FROM, precisionOf } from "./cohort";

describe("D90 — a served comparison says how far it can be leaned on", () => {
  it("fair at the threshold with no wide widening; rough one below it", () => {
    expect(precisionOf(PRECISION_FAIR_FROM, [])).toEqual({ level: "fair", reasons: [] });
    expect(precisionOf(PRECISION_FAIR_FROM - 1, [])).toEqual({
      level: "rough",
      reasons: ["few_businesses"],
    });
  });

  it("at the privacy floor of seven it is always rough", () => {
    expect(precisionOf(7, []).level).toBe("rough");
  });

  it("a 3-digit NACE widening is a close neighbour and stays fair", () => {
    expect(precisionOf(40, ["nace_3"])).toEqual({ level: "fair", reasons: [] });
  });

  it("widening to the 2-digit division, a region, or every size makes it rough, each named", () => {
    expect(precisionOf(40, ["nace_3", "nace_2"]).reasons).toEqual(["wide_industry"]);
    expect(precisionOf(40, ["region"]).reasons).toEqual(["wide_area"]);
    expect(precisionOf(40, ["any_band"]).reasons).toEqual(["any_size"]);
    expect(precisionOf(9, ["nace_3", "nace_2", "region", "any_band"])).toEqual({
      level: "rough",
      reasons: ["few_businesses", "wide_industry", "wide_area", "any_size"],
    });
  });
});
