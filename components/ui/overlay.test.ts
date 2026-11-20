import { describe, expect, it } from "vitest";
import { nudgeInto, trapTarget } from "./overlay";

// A menu hangs from its button and still has to sit inside the window (A4).
describe("how far a menu moves to stay inside the window", () => {
  it("stays where it hangs when it fits", () => {
    expect(nudgeInto(900, 1160, 1440, 12)).toBe(0);
    expect(nudgeInto(12, 272, 390, 12)).toBe(0);
  });

  it("moves right when it began off the left edge, as under the phone's bell", () => {
    expect(nudgeInto(-61, 199, 390, 12)).toBe(73);
  });

  it("moves left when it ran off the right edge", () => {
    expect(nudgeInto(1200, 1460, 1440, 12)).toBe(-32);
  });

  it("starts at the left edge when it is wider than the room", () => {
    expect(nudgeInto(40, 440, 390, 12)).toBe(-28);
  });
});

// An overlay keeps the Tab key inside it (docs/DASHBOARD-OVERHAUL.md G1).
describe("where Tab goes inside an overlay", () => {
  it("wraps from the last stop to the first, and back with Shift", () => {
    expect(trapTarget(3, 2, false)).toBe(0);
    expect(trapTarget(3, 0, true)).toBe(2);
  });

  it("leaves the browser alone in the middle", () => {
    expect(trapTarget(3, 0, false)).toBeNull();
    expect(trapTarget(3, 1, false)).toBeNull();
    expect(trapTarget(3, 1, true)).toBeNull();
    expect(trapTarget(3, 2, true)).toBeNull();
  });

  it("pulls a focus that has left the overlay back in", () => {
    expect(trapTarget(3, -1, false)).toBe(0);
    expect(trapTarget(3, -1, true)).toBe(2);
  });

  it("has nowhere to send it when the overlay holds no stop", () => {
    expect(trapTarget(0, -1, false)).toBeNull();
    expect(trapTarget(0, -1, true)).toBeNull();
  });
});
