import { describe, expect, it } from "vitest";
import { SECTIONS, sectionFor, showsNav } from "./AppFrame";

// ux-spec §3: one rail, at most five entries, every owner screen reachable.
describe("app navigation", () => {
  it("has at most five sections", () => {
    expect(SECTIONS.length).toBeLessThanOrEqual(5);
  });

  it("places every owner screen in exactly one section", () => {
    const hrefs = SECTIONS.flatMap((s) => s.tabs.map((t) => t.href));
    expect(new Set(hrefs).size).toBe(hrefs.length);
    for (const href of hrefs) expect(sectionFor(href)).not.toBeNull();
    expect(sectionFor("/customers")?.key).toBe("customers");
    expect(sectionFor("/site")?.key).toBe("grow");
  });

  it("shows the rail on owner screens and the chat", () => {
    expect(showsNav("/report")).toBe(true);
    expect(showsNav("/chat")).toBe(true);
  });

  it("keeps the rail off the landing, intake, sign-in, operator and widget test pages", () => {
    for (const p of ["/", "/intake", "/login", "/ops", "/support/test"]) {
      expect(showsNav(p)).toBe(false);
    }
  });
});
