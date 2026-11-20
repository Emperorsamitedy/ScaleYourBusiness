// The labels down a chart's right edge never sit on each other.

import { describe, expect, it } from "vitest";
import { spreadLabels } from "./labels";

describe("spreadLabels", () => {
  it("leaves labels alone when they already have room", () => {
    const got = spreadLabels(
      [
        { key: "high", y: 30 },
        { key: "low", y: 100 },
        { key: "line", y: 180 },
      ],
      10,
      220,
      14,
    );
    expect(got.map((l) => l.y)).toEqual([30, 100, 180]);
  });

  it("pushes two that collide apart, in their own order", () => {
    const got = spreadLabels(
      [
        { key: "low", y: 101 },
        { key: "line", y: 100 },
      ],
      10,
      220,
      14,
    );
    // The line sat above the low end, so it stays above it.
    expect(got.find((l) => l.key === "line")!.y).toBe(100);
    expect(got.find((l) => l.key === "low")!.y).toBe(114);
  });

  it("keeps them inside the plot at the bottom edge", () => {
    const got = spreadLabels(
      [
        { key: "a", y: 215 },
        { key: "b", y: 218 },
        { key: "c", y: 219 },
      ],
      10,
      220,
      14,
    );
    expect(got.map((l) => l.y)).toEqual([192, 206, 220]);
  });

  it("returns the labels in the order it was given them", () => {
    const got = spreadLabels(
      [
        { key: "z", y: 200 },
        { key: "a", y: 20 },
      ],
      10,
      220,
      14,
    );
    expect(got.map((l) => l.key)).toEqual(["z", "a"]);
  });
});
