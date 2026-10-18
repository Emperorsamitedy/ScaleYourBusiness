import { describe, expect, it } from "vitest";
import { GROUPS, groupFor, showsNav } from "./AppFrame";

// The owner's menu design: five labelled groups, every owner screen in one.
describe("app navigation", () => {
  it("has the five groups of the menu design", () => {
    expect(GROUPS.map((g) => g.label)).toEqual([
      "To approve",
      "Insights",
      "Grow",
      "Customers",
      "Your business",
    ]);
  });

  it("places every owner screen in exactly one group", () => {
    const hrefs = GROUPS.flatMap((g) => g.items.map((i) => i.href));
    expect(new Set(hrefs).size).toBe(hrefs.length);
    for (const href of hrefs) expect(groupFor(href)).not.toBeNull();
    expect(groupFor("/customers")?.key).toBe("customers");
    expect(groupFor("/site")?.key).toBe("grow");
  });

  it("shows the rail on owner screens and the chat", () => {
    expect(showsNav("/watch")).toBe(true);
    expect(showsNav("/chat")).toBe(true);
  });

  it("keeps the rail off focused views and public pages", () => {
    for (const p of ["/report", "/proposals", "/", "/intake", "/login", "/ops", "/support/test"]) {
      expect(showsNav(p)).toBe(false);
    }
  });
});
