import { describe, expect, it } from "vitest";
import { niceTicks } from "./ticks";

describe("niceTicks", () => {
  it("covers the range at round numbers", () => {
    expect(niceTicks(1015, 2878)).toEqual([1000, 1500, 2000, 2500, 3000]);
    expect(niceTicks(18, 40)).toEqual([10, 20, 30, 40]);
    expect(niceTicks(0, 100, 5)).toEqual([0, 20, 40, 60, 80, 100]);
  });

  it("keeps fractions exact", () => {
    expect(niceTicks(0.1, 0.9)).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
  });

  it("gives a usable scale to a flat series, and none to a broken one", () => {
    expect(niceTicks(0, 0)).toEqual([0, 1]);
    expect(niceTicks(50, 50)).toEqual([0, 20, 40, 60]);
    expect(niceTicks(Number.NaN, 3)).toEqual([]);
  });

  it("reads a reversed range the same way", () => {
    expect(niceTicks(40, 18)).toEqual(niceTicks(18, 40));
  });
});
