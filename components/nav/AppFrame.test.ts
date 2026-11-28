import { describe, expect, it } from "vitest";
import type { NavCounts } from "../../app/api/nav/route";
import { SIZE_BANDS } from "../../lib/core/size-features";
import {
  GROUPS,
  PLACES,
  connectionsCount,
  foldsRail,
  groupFor,
  groupHome,
  onItem,
  placeFor,
  placeGroups,
  placeHasRail,
  railGroupsFor,
  placeHome,
  railItems,
  railMore,
  roleLine,
  showsNav,
  stripStop,
  supportCount,
  visibleGroups,
  waitsForSetUp,
} from "./AppFrame";
import { PLACE_ICONS, SCREEN_ICONS } from "./nav-icons";

// The owner's menu design, reorganised 2026-11-15: six labelled groups, Today first.
describe("app navigation", () => {
  it("has the six groups of the menu design, Today first", () => {
    expect(GROUPS.map((g) => g.label)).toEqual([
      "Today",
      "To approve",
      "Insights",
      "Grow",
      "Keep customers", // 2026-11-23: Grow's second half, said plainly
      "Your business",
    ]);
  });

  it("opens each group on its first main screen", () => {
    const home = Object.fromEntries(GROUPS.map((g) => [g.key, groupHome(g)]));
    expect(home).toEqual({
      today: "/home",
      approve: "/proposals",
      insights: "/report",
      grow: "/grow", // 2026-11-23: Grow opens on its front page
      customers: "/customers",
      business: "/profile",
    });
    expect(groupHome({ items: [] })).toBe("/home");
  });

  it("places every owner screen in exactly one group", () => {
    const hrefs = GROUPS.flatMap((g) => g.items.map((i) => i.href));
    expect(new Set(hrefs).size).toBe(hrefs.length);
    for (const href of hrefs) expect(groupFor(href)).not.toBeNull();
    expect(groupFor("/customers")?.key).toBe("customers");
    expect(groupFor("/site")?.key).toBe("grow");
    expect(groupFor("/simulate")?.key).toBe("grow");
    expect(groupFor("/cash")?.key).toBe("insights");
  });

  it("puts owner screens and the chat inside the frame", () => {
    expect(showsNav("/watch")).toBe(true);
    expect(showsNav("/home")).toBe(true);
    expect(showsNav("/chat")).toBe(true);
  });

  // 2026-11-20: the shadow summary is opened from "What I may do" and had no
  // frame around it, because no menu item's address starts "/shadow".
  it("keeps a screen's page inside the frame when it lives at an address of its own", () => {
    const ladder = GROUPS.flatMap((g) => g.items).find((i) => i.href === "/ladder")!;
    expect(onItem("/shadow", ladder)).toBe(true);
    expect(onItem("/ladder", ladder)).toBe(true);
    expect(onItem("/shadowy", ladder)).toBe(false);
    expect(showsNav("/shadow")).toBe(true);
    expect(groupFor("/shadow")?.key).toBe(groupFor("/ladder")?.key);
    // A stranger's copy of it is still outside: it is somebody else's page.
    expect(showsNav("/shared/shadow/abc")).toBe(false);
    // And no page is claimed by two screens.
    const pages = GROUPS.flatMap((g) => g.items.flatMap((i) => i.pages ?? []));
    expect(new Set(pages).size).toBe(pages.length);
    const hrefs = GROUPS.flatMap((g) => g.items.map((i) => i.href));
    for (const p of pages) expect(hrefs).not.toContain(p);
  });

  // 2026-11-18: the rail lists a group's main screens first; the rest wait behind "more".
  it("lists a group's main screens first in the rail, plus the one open now", () => {
    const insights = GROUPS.find((g) => g.key === "insights")!;
    expect(railItems(insights, "/watch").map((i) => i.href)).toEqual([
      "/report",
      "/watch",
      "/progress",
      "/cash",
    ]);
    expect(railItems(insights, "/hours").map((i) => i.href)).toContain("/hours");
    const grow = GROUPS.find((g) => g.key === "grow")!;
    expect(railItems(grow, "/home")).toEqual(grow.items); // every tool is a main one: all listed
  });

  it("keeps the rest of a group behind more, and loses none of its screens", () => {
    const insights = GROUPS.find((g) => g.key === "insights")!;
    const first = railItems(insights, "/watch");
    const rest = railMore(insights, "/watch");
    expect(rest.map((i) => i.href)).toContain("/hours");
    expect(rest.some((i) => first.includes(i))).toBe(false);
    expect(first.length + rest.length).toBe(insights.items.length);
    // the open screen moves out from behind "more"
    expect(railMore(insights, "/hours").map((i) => i.href)).not.toContain("/hours");
    const grow = GROUPS.find((g) => g.key === "grow")!;
    expect(railMore(grow, "/home")).toEqual([]);
  });

  // The owner, 2026-11-18: "up to 4 max" across the top.
  it("has four places across the top and one behind the business's name", () => {
    expect(PLACES.filter((p) => p.top).map((p) => p.key)).toEqual([
      "home",
      "decisions",
      "insights",
      "grow",
    ]);
    expect(PLACES.filter((p) => !p.top).map((p) => p.key)).toEqual(["business"]);
    expect(PLACES.filter((p) => p.top).length).toBeLessThanOrEqual(4);
  });

  it("puts every group in exactly one place, so every screen has one", () => {
    const placed = PLACES.flatMap((p) => p.groups);
    expect([...placed].sort()).toEqual(GROUPS.map((g) => g.key).sort());
    expect(new Set(placed).size).toBe(placed.length);
    for (const g of GROUPS)
      for (const i of g.items) expect(placeFor(i.href), i.href).not.toBeNull();
  });

  it("finds a screen's place: Customers inside Grow, the conversation at Home", () => {
    expect(placeFor("/home")).toBe("home");
    expect(placeFor("/chat")).toBe("home");
    expect(placeFor("/proposals")).toBe("decisions");
    expect(placeFor("/ladder")).toBe("decisions");
    expect(placeFor("/cash")).toBe("insights");
    expect(placeFor("/content")).toBe("grow");
    expect(placeFor("/customers")).toBe("grow");
    expect(placeFor("/support")).toBe("grow");
    expect(placeFor("/profile")).toBe("business");
    expect(placeFor("/settings/language")).toBe("business");
    expect(placeFor("/")).toBeNull();
    expect(placeFor("/login")).toBeNull();
  });

  it("opens each place on its first main screen", () => {
    expect(placeHome("home", GROUPS)).toBe("/home");
    expect(placeHome("decisions", GROUPS)).toBe("/proposals");
    expect(placeHome("insights", GROUPS)).toBe("/report");
    expect(placeHome("grow", GROUPS)).toBe("/grow");
    expect(placeHome("business", GROUPS)).toBe("/profile");
    expect(placeHome("grow", [])).toBe("/home"); // nothing to open: Home
  });

  it("lists a place's groups in the place's order: Grow, then Customers", () => {
    expect(placeGroups("grow", GROUPS).map((g) => g.key)).toEqual(["grow", "customers"]);
    expect(placeGroups("insights", GROUPS).map((g) => g.key)).toEqual(["insights"]);
    // a group this business does not see is simply absent
    const without = GROUPS.filter((g) => g.key !== "customers");
    expect(placeGroups("grow", without).map((g) => g.key)).toEqual(["grow"]);
  });

  it("gives a place a rail only when it has more than one screen on it", () => {
    // 2026-11-23: Home's rail is "Your business", which no longer sits behind a menu.
    expect(placeHasRail("home", GROUPS)).toBe(true);
    expect(placeHasRail("decisions", GROUPS)).toBe(true);
    expect(placeHasRail("insights", GROUPS)).toBe(true);
    expect(placeHasRail("grow", GROUPS)).toBe(true);
    expect(placeHasRail("business", GROUPS)).toBe(true);
    expect(placeHasRail("decisions", [])).toBe(false);
  });

  // The owner, 2026-11-23: "all those things that are under the business's name has to be on the left bar".
  it("puts Your business on Home's rail, and last on every other place's", () => {
    expect(railGroupsFor("home", GROUPS).map((g) => g.key)).toEqual(["business"]);
    expect(railGroupsFor("business", GROUPS).map((g) => g.key)).toEqual(["business"]);
    expect(railGroupsFor("grow", GROUPS).map((g) => g.key)).toEqual([
      "grow",
      "customers",
      "business",
    ]);
    expect(railGroupsFor("decisions", GROUPS).at(-1)?.key).toBe("business");
    // a business that sees none of it has only the place's own screens
    const without = GROUPS.filter((g) => g.key !== "business");
    expect(railGroupsFor("insights", without).map((g) => g.key)).toEqual(["insights"]);
    expect(railGroupsFor("home", without)).toEqual([]);
  });

  // The owner: "all tabs having their own icons".
  it("has an icon for every screen and every place across the top", () => {
    for (const g of GROUPS)
      for (const i of g.items) expect(SCREEN_ICONS[i.href], i.href).toBeDefined();
    for (const p of PLACES.filter((x) => x.top)) expect(PLACE_ICONS[p.key], p.key).toBeDefined();
    expect(SCREEN_ICONS["/nowhere"]).toBeUndefined();
  });

  it("puts the emergency stop in the bar, except where the screen carries its own", () => {
    expect(stripStop("/home")).toBe(true);
    expect(stripStop("/watch")).toBe(true);
    expect(stripStop("/content")).toBe(false);
    expect(stripStop("/site")).toBe(true); // 2026-11-23: the Website page gave its own up
  });

  it("files What I may do under To approve, beside the queue", () => {
    expect(groupFor("/ladder")?.key).toBe("approve");
    expect(groupFor("/home")?.key).toBe("today");
  });

  // The owner, 2026-11-18: from the screens that filled the window "there's no
  // clear way to go back". The queue and the report are inside the frame now.
  it("keeps the queue and the report inside the frame, with the rail folded", () => {
    expect(showsNav("/report")).toBe(true);
    expect(showsNav("/proposals")).toBe(true);
    expect(foldsRail("/report")).toBe(true);
    expect(foldsRail("/proposals")).toBe(true);
    expect(foldsRail("/proposals/abc")).toBe(true);
    expect(foldsRail("/watch")).toBe(false);
    expect(foldsRail("/home")).toBe(false);
  });

  it("keeps the frame off public pages", () => {
    for (const p of ["/", "/intake", "/login", "/ops", "/support/test", "/shared/abc"]) {
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

  // P5-18 (rule 28): the team module is off by default, so its item is too.
  it("leaves Team cover out of the menu unless the team module is switched on", () => {
    const counts: NavCounts = {
      set_up: true,
      business: "Lumen Hair Studio",
      business_type: null,
      watch: null,
      pending: 0,
      by_module: {},
      goals: 0,
      facts: 0,
      connections: 0,
      needs_reconnect: 0,
      support_open: 0,
      size_band: null,
      stock: false,
      team: false,
      pipeline: false,
      carts: false,
      access: { role: "owner", signed_in: true, businesses: [] },
    };
    const hrefs = (c: NavCounts | null) =>
      visibleGroups(null, c).flatMap((g) => g.items.map((i) => i.href));
    expect(hrefs(counts)).not.toContain("/team");
    expect(hrefs(null)).not.toContain("/team"); // still loading: hidden, never guessed
    expect(hrefs({ ...counts, team: true })).toContain("/team");
    expect(groupFor("/team")?.key).toBe("insights");
  });

  // Idea 47: Abandoned carts sits under Customers, only with a store connection that reads carts.
  it("shows Abandoned carts under Customers only when a shop connection reads carts", () => {
    const counts: NavCounts = {
      set_up: true,
      business: "Fernhill Ceramics",
      business_type: null,
      watch: null,
      pending: 0,
      by_module: {},
      goals: 0,
      facts: 0,
      connections: 1,
      needs_reconnect: 0,
      support_open: 0,
      size_band: null,
      stock: true,
      team: false,
      pipeline: false,
      carts: false,
      access: { role: "owner", signed_in: true, businesses: [] },
    };
    const hrefs = (c: NavCounts | null) =>
      visibleGroups(null, c).flatMap((g) => g.items.map((i) => i.href));
    expect(hrefs(counts)).not.toContain("/carts");
    expect(hrefs(null)).not.toContain("/carts"); // still loading: hidden, never guessed
    expect(hrefs({ ...counts, carts: true })).toContain("/carts");
    expect(groupFor("/carts")?.key).toBe("customers");
  });

  // Idea 45: Reviews sits under Customers, for every business, right after Customers.
  it("shows Reviews under Customers for every business", () => {
    const customers = GROUPS.find((g) => g.key === "customers")!;
    const hrefs = customers.items.map((i) => i.href);
    expect(hrefs.indexOf("/reviews")).toBe(hrefs.indexOf("/customers") + 1);
    expect(groupFor("/reviews")?.key).toBe("customers");
    expect(customers.items.find((i) => i.href === "/reviews")?.appliesTo).toBeUndefined();
  });
});

// Idea 52: the team screen exists once someone has signed up; the role is said quietly.
describe("several businesses and the team", () => {
  const base = {
    set_up: true,
    business: "Fernhill Ceramics",
    business_type: null,
    watch: null,
    pending: 0,
    by_module: {},
    goals: 0,
    facts: 0,
    connections: 0,
    needs_reconnect: 0,
    support_open: 0,
    size_band: null,
    stock: false,
    team: false,
    pipeline: false,
    carts: false,
  };
  const hrefs = (c: NavCounts) => visibleGroups(null, c).flatMap((g) => g.items.map((i) => i.href));

  it("lists Team access under Your business for a signed-in person only", () => {
    const signedIn: NavCounts = {
      ...base,
      access: { role: "viewer", signed_in: true, businesses: [] },
    };
    const anonymous: NavCounts = {
      ...base,
      access: { role: "owner", signed_in: false, businesses: [] },
    };
    expect(hrefs(signedIn)).toContain("/settings/team");
    expect(hrefs(anonymous)).not.toContain("/settings/team");
    expect(groupFor("/settings/team")?.key).toBe("business");
    expect(showsNav("/settings/team")).toBe(true);
    // Counts from before idea 52 (no access field) hide it rather than throw.
    expect(hrefs(base as unknown as NavCounts)).not.toContain("/settings/team");
  });

  // Least privilege (the owner's decision of 2026-11-09): /api/payments refuses them, so the menu hides it.
  it("lists Payments for an owner only, never a manager or a viewer", () => {
    const as = (role: "owner" | "manager" | "viewer", signed_in = true): NavCounts => ({
      ...base,
      access: { role, signed_in, businesses: [] },
    });
    expect(hrefs(as("owner"))).toContain("/payments");
    expect(hrefs(as("owner", false))).toContain("/payments"); // the interview's own person
    expect(hrefs(as("manager"))).not.toContain("/payments");
    expect(hrefs(as("viewer"))).not.toContain("/payments");
    expect(hrefs(base as unknown as NavCounts)).not.toContain("/payments");
    expect(groupFor("/payments")?.key).toBe("insights");
  });

  it("says the role in plain words, and nothing before sign-up", () => {
    const line = (role: "owner" | "manager" | "viewer", signed_in = true) =>
      roleLine({ role, signed_in, businesses: [] });
    expect(line("owner")).toBe("You're an owner here");
    expect(line("manager")).toBe("You're a manager here");
    expect(line("viewer")).toBe("You're a viewer here: you can read, and press stop");
    expect(line("owner", false)).toBeNull();
    expect(roleLine(null)).toBeNull();
  });
});

describe("waitsForSetUp: the journey (ux-spec §7.0)", () => {
  const notYet = { set_up: false };
  const ready = { set_up: true };

  it("dims the screens that read the business's data until its first diagnosis", () => {
    expect(waitsForSetUp("insights", { href: "/cash" }, notYet)).toBe(true);
    expect(waitsForSetUp("grow", { href: "/content" }, notYet)).toBe(true);
    expect(waitsForSetUp("customers", { href: "/customers" }, notYet)).toBe(true);
    expect(waitsForSetUp("approve", { href: "/proposals" }, notYet)).toBe(true);
  });

  it("never dims Home, the report itself, or the business's own settings", () => {
    expect(waitsForSetUp("today", { href: "/home" }, notYet)).toBe(false);
    expect(waitsForSetUp("insights", { href: "/report" }, notYet)).toBe(false);
    expect(waitsForSetUp("business", { href: "/connections" }, notYet)).toBe(false);
    expect(waitsForSetUp("business", { href: "/profile" }, notYet)).toBe(false);
  });

  it("dims nothing once set up, or while the counts are still loading", () => {
    expect(waitsForSetUp("insights", { href: "/cash" }, ready)).toBe(false);
    expect(waitsForSetUp("insights", { href: "/cash" }, null)).toBe(false);
  });
});
