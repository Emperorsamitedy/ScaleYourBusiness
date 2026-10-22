import { describe, expect, it } from "vitest";
import { SIZE_BANDS } from "../../lib/core/size-features";
import {
  GROUPS,
  connectionsCount,
  groupFor,
  showsNav,
  supportCount,
  visibleGroups,
} from "./AppFrame";

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
    expect(groupFor("/simulate")?.key).toBe("grow");
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

  // P3-24b: the needs-you flag is a count beside an item, in words, no icon.
  it("says how many write connections paused themselves beside Connections, else the connected count", () => {
    expect(connectionsCount({ connections: 3, needs_reconnect: 1 })).toBe("1 paused");
    expect(connectionsCount({ connections: 3, needs_reconnect: 2 })).toBe("2 paused");
    expect(connectionsCount({ connections: 3, needs_reconnect: 0 })).toBe("3");
    expect(connectionsCount({ connections: 0, needs_reconnect: 0 })).toBeNull();
    const item = GROUPS.flatMap((g) => g.items).find((i) => i.href === "/connections");
    expect(item?.count).toBe(connectionsCount);
  });

  // P4-11: the open-ticket count sits on the existing Support item, in words.
  it("puts open tickets beside Support, else the pending support proposals", () => {
    expect(supportCount({ support_open: 2, by_module: { support: 1 } })).toBe("2 open");
    expect(supportCount({ support_open: 0, by_module: { support: 1 } })).toBe("1");
    expect(supportCount({ support_open: 0, by_module: {} })).toBeNull();
    const item = GROUPS.flatMap((g) => g.items).find((i) => i.href === "/support");
    expect(item?.count).toBe(supportCount);
  });

  // Size: the menu reads the size-feature table; an unknown band shows everything.
  it("shows every item when the size band is unknown", () => {
    expect(visibleGroups(null)).toEqual(GROUPS);
  });

  it("shows each band a deterministic menu, every group still holding an item", () => {
    for (const band of SIZE_BANDS) {
      const a = visibleGroups(band);
      expect(visibleGroups(band)).toEqual(a);
      for (const g of a) expect(g.items.length).toBeGreaterThan(0);
    }
  });
});
