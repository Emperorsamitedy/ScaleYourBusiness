// What Home shows and in what order, as the owner arranged it (home-layout.ts).

import { describe, expect, it } from "vitest";
import {
  DEFAULT_LAYOUT,
  isDefault,
  moved,
  readLayout,
  shows,
  toggled,
  writeLayout,
} from "./home-layout";

describe("Home as the owner arranged it", () => {
  it("shows everything in its usual order until something is changed", () => {
    expect(DEFAULT_LAYOUT.order).toEqual(["cash", "visitors", "sales", "slips"]);
    expect(isDefault(DEFAULT_LAYOUT)).toBe(true);
    expect(shows(DEFAULT_LAYOUT, "sales")).toBe(true);
    expect(shows(DEFAULT_LAYOUT, "work")).toBe(true);
  });

  it("hides a block and shows it again", () => {
    const hidden = toggled(DEFAULT_LAYOUT, "visitors");
    expect(shows(hidden, "visitors")).toBe(false);
    expect(isDefault(hidden)).toBe(false);
    // Hidden, it keeps its place in the order: shown again, it is where it was.
    expect(hidden.order).toEqual(DEFAULT_LAYOUT.order);
    expect(isDefault(toggled(hidden, "visitors"))).toBe(true);
  });

  it("moves a card one place, and leaves it where it is at either end", () => {
    const up = moved(DEFAULT_LAYOUT, "visitors", -1);
    expect(up.order).toEqual(["visitors", "cash", "sales", "slips"]);
    expect(isDefault(up)).toBe(false);
    expect(moved(up, "visitors", -1)).toBe(up); // already first
    expect(moved(DEFAULT_LAYOUT, "slips", 1)).toBe(DEFAULT_LAYOUT); // already last
    expect(moved(up, "visitors", 1).order).toEqual(DEFAULT_LAYOUT.order);
  });
});

describe("the layout a browser kept", () => {
  it("comes back as it was kept", () => {
    const mine = toggled(moved(DEFAULT_LAYOUT, "slips", -1), "work");
    expect(readLayout(writeLayout(mine))).toEqual(mine);
  });

  it("is the default when nothing was kept or it cannot be read", () => {
    expect(readLayout(null)).toEqual(DEFAULT_LAYOUT);
    expect(readLayout("")).toEqual(DEFAULT_LAYOUT);
    expect(readLayout("{not json")).toEqual(DEFAULT_LAYOUT);
    expect(readLayout('"a string"')).toEqual(DEFAULT_LAYOUT);
    expect(readLayout("null")).toEqual(DEFAULT_LAYOUT);
  });

  it("drops what it does not know and gives a card added since its place at the end", () => {
    // Kept by an older version: one card unknown now, one missing, one named twice.
    const read = readLayout(
      JSON.stringify({ order: ["slips", "weather", "cash", "slips"], hidden: ["weather", "cash"] }),
    );
    expect(read.order).toEqual(["slips", "cash", "visitors", "sales"]);
    expect(read.hidden).toEqual(["cash"]);
    // What needs the owner and Lex's status are not blocks: they cannot be hidden.
    expect(readLayout(JSON.stringify({ hidden: ["needs", "status"] })).hidden).toEqual([]);
  });
});
