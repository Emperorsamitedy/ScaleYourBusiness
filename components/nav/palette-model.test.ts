import { describe, expect, it } from "vitest";
import type { PaletteItem } from "./palette-model";
import { filterItems, fold, moveActive, paletteRows, pushRecent, score } from "./palette-model";

const screen = (href: string, label: string, hint = "", keywords = ""): PaletteItem => ({
  id: `screen:${href}`,
  kind: "screen",
  label,
  hint,
  href,
  keywords,
});
const SCREENS = [
  screen("/home", "Home", "Today"),
  screen("/proposals", "Waiting for you", "To approve"),
  screen("/cash", "Cash flow", "Insights"),
  screen("/watch", "Watching", "Insights"),
  screen("/profile", "Fact sheet", "Your business"),
  screen("/site", "Site web", "Développer", "Website"),
];
const ACTIONS: PaletteItem[] = [
  { id: "action:ask", kind: "action", label: "Ask Lex" },
  { id: "action:signout", kind: "action", label: "Sign out" },
];
const ask = (question: string): PaletteItem => ({ id: "ask", kind: "ask", label: question });

describe("the palette's matching", () => {
  it("ignores case and accents", () => {
    expect(fold("  Café Überall ")).toBe("cafe uberall");
    expect(score(screen("/x", "Trésorerie"), "tres")).toBe(3);
    expect(score(screen("/x", "Überblick"), "uber")).toBe(3);
  });

  it("ranks a label's start over a word's start over anywhere", () => {
    expect(score(SCREENS[2]!, "cash")).toBe(3);
    expect(score(SCREENS[2]!, "flow")).toBe(2);
    expect(score(SCREENS[2]!, "ash")).toBe(1);
    expect(score(SCREENS[2]!, "insig")).toBe(1); // the group counts, after the label
    expect(score(SCREENS[5]!, "website")).toBe(1); // and so do the unseen keywords
    expect(score(SCREENS[2]!, "zebra")).toBe(0);
  });

  it("keeps only what fits, the best fit first, ties in menu order", () => {
    expect(filterItems(SCREENS, "wa").map((s) => s.href)).toEqual(["/proposals", "/watch"]);
    expect(filterItems(SCREENS, "f").map((s) => s.href)).toEqual([
      "/profile",
      "/proposals",
      "/cash",
    ]);
    expect(filterItems(SCREENS, "zebra")).toEqual([]);
    expect(filterItems(SCREENS, "", 2)).toHaveLength(2);
  });
});

describe("the palette's rows", () => {
  it("lists recent screens first when nothing is typed, never the open one", () => {
    const rows = paletteRows({
      query: "",
      screens: SCREENS,
      actions: ACTIONS,
      recent: ["/cash", "/home", "/gone", "/watch"],
      current: "/home",
      ask,
    });
    expect(rows.slice(0, 2).map((r) => `${r.kind}:${r.href}`)).toEqual([
      "recent:/cash",
      "recent:/watch",
    ]);
    expect(rows.slice(2, 4).map((r) => r.id)).toEqual(["action:ask", "action:signout"]);
    expect(rows).toHaveLength(2 + ACTIONS.length + SCREENS.length);
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length); // ids stay unique
  });

  it("ends a typed query with the row that asks Lex, even when nothing fits", () => {
    const some = paletteRows({
      query: "cash",
      screens: SCREENS,
      actions: ACTIONS,
      recent: [],
      current: "/home",
      ask,
    });
    expect(some.map((r) => r.id)).toEqual(["screen:/cash", "ask"]);
    const none = paletteRows({
      query: "why did sales dip?",
      screens: SCREENS,
      actions: ACTIONS,
      recent: [],
      current: "/home",
      ask,
    });
    expect(none).toEqual([{ id: "ask", kind: "ask", label: "why did sales dip?" }]);
  });
});

describe("the palette's small rules", () => {
  it("remembers each screen once, the latest first, and no more than asked", () => {
    expect(pushRecent(["/a", "/b", "/c"], "/b")).toEqual(["/b", "/a", "/c"]);
    expect(pushRecent(["/a", "/b"], "/c", 2)).toEqual(["/c", "/a"]);
  });

  it("wraps the arrow keys at both ends, and has nowhere to go in an empty list", () => {
    expect(moveActive(3, 2, 1)).toBe(0);
    expect(moveActive(3, 0, -1)).toBe(2);
    expect(moveActive(3, -1, 1)).toBe(0);
    expect(moveActive(0, 0, 1)).toBe(-1);
  });
});
