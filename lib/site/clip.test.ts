// A site change's title shows what changes: the find and its replacement
// are clipped around where they differ, not from their starts.

import "dotenv/config";
import { describe, expect, it } from "vitest";
import { clipPair } from "./changes";

describe("clipPair", () => {
  it("keeps short texts whole", () => {
    expect(clipPair("Free UK delivery", "Free UK and EU delivery")).toEqual({
      find: "Free UK delivery",
      replace: "Free UK and EU delivery",
    });
  });

  it("shows the inserted words when the two share a long opening", () => {
    const find =
      "A 350 ml mug thrown on the wheel and dipped in our oatmeal speckle glaze. Every one is slightly different.";
    const replace =
      "A 350 ml mug thrown on the wheel and dipped in our oatmeal speckle glaze. Dishwasher and microwave safe. Every one is slightly different.";
    const out = clipPair(find, replace);
    expect(out.replace).toContain("Dishwasher and microwave safe.");
    expect(out.find.startsWith("…")).toBe(true);
    expect(out.replace.startsWith("…")).toBe(true);
    // The two sides open on the same shared words, so they read as one sentence changed.
    expect(out.find.slice(0, 12)).toBe(out.replace.slice(0, 12));
    expect(out.find.length).toBeLessThanOrEqual(62);
    expect(out.replace.length).toBeLessThanOrEqual(62);
  });

  it("clips a long difference itself to 60", () => {
    const out = clipPair("x".repeat(80), "y".repeat(90));
    expect(out.find).toBe(`${"x".repeat(57)}…`);
    expect(out.replace).toBe(`${"y".repeat(57)}…`);
  });
});
