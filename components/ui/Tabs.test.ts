import { describe, expect, it } from "vitest";
import { tabTarget } from "./Tabs";

// docs/DASHBOARD-OVERHAUL.md A3: arrow keys move, the open tab is the only tab stop.
describe("tabs: where a key moves", () => {
  it("moves right and left, wrapping at the ends", () => {
    expect(tabTarget(3, 0, "ArrowRight")).toBe(1);
    expect(tabTarget(3, 2, "ArrowRight")).toBe(0);
    expect(tabTarget(3, 0, "ArrowLeft")).toBe(2);
    expect(tabTarget(3, 1, "ArrowLeft")).toBe(0);
  });

  it("jumps to the first and the last", () => {
    expect(tabTarget(3, 1, "Home")).toBe(0);
    expect(tabTarget(3, 1, "End")).toBe(2);
  });

  it("leaves every other key alone, and an empty row too", () => {
    expect(tabTarget(3, 1, "Enter")).toBeNull();
    expect(tabTarget(3, 1, "a")).toBeNull();
    expect(tabTarget(0, 0, "ArrowRight")).toBeNull();
  });
});
