// The peer strip's scale: the middle half and the reader's own figure both
// fit, and nothing is drawn from a figure that is not there.

import { describe, expect, it } from "vitest";
import { peerStrip } from "./peer-strip";

describe("peerStrip — where the middle half and the reader's tick sit", () => {
  it("pads the quartiles and the own figure by a tenth of their span", () => {
    expect(peerStrip(4_000, 6_000, 5_000)).toEqual({ scale: [3_800, 6_200], band: [4_000, 6_000] });
  });

  it("stretches to an own figure outside the middle half, on either side", () => {
    expect(peerStrip(4_000, 6_000, 9_000)).toEqual({ scale: [3_500, 9_500], band: [4_000, 6_000] });
    expect(peerStrip(4_000, 6_000, 1_000)?.scale).toEqual([500, 6_500]);
  });

  it("draws nothing when a quartile or the own figure is missing", () => {
    expect(peerStrip(undefined, 6_000, 5_000)).toBeNull();
    expect(peerStrip(4_000, null, 5_000)).toBeNull();
    expect(peerStrip(4_000, 6_000, null)).toBeNull();
    expect(peerStrip(4_000, Number.NaN, 5_000)).toBeNull();
  });

  it("draws nothing from quartiles out of order, or when all three are one point", () => {
    expect(peerStrip(6_000, 4_000, 5_000)).toBeNull();
    expect(peerStrip(5_000, 5_000, 5_000)).toBeNull();
  });
});
