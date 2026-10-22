// Feature 35 — robots.txt, RFC 9309. Pure.

import { describe, expect, it } from "vitest";
import { ALLOW_ALL, DISALLOW_ALL, parseRobots, robotsAllows, robotsFromResponse } from "./robots";

const u = (path: string) => new URL(`https://studionova.example${path}`);

describe("robots.txt", () => {
  it("honours a disallow in the * group", () => {
    const rules = parseRobots("User-agent: *\nDisallow: /prices\n");
    expect(robotsAllows(rules, u("/prices"))).toBe(false);
    expect(robotsAllows(rules, u("/prices/hair"))).toBe(false);
    expect(robotsAllows(rules, u("/about"))).toBe(true);
  });

  it("uses our own group over *, case-insensitively", () => {
    const rules = parseRobots("User-agent: *\nDisallow:\n\nUser-agent: Ledgerline\nDisallow: /\n");
    expect(robotsAllows(rules, u("/"))).toBe(false);
    const ours = parseRobots(
      "User-agent: *\nDisallow: /\n\nUser-agent: ledgerline-competitorread\nAllow: /\n",
    );
    expect(robotsAllows(ours, u("/prices"))).toBe(true);
  });

  it("lets the longest rule decide, and Allow win a tie", () => {
    const rules = parseRobots("User-agent: *\nDisallow: /shop\nAllow: /shop/prices\n");
    expect(robotsAllows(rules, u("/shop/cart"))).toBe(false);
    expect(robotsAllows(rules, u("/shop/prices"))).toBe(true);
  });

  it("understands * and $", () => {
    const rules = parseRobots("User-agent: *\nDisallow: /*.pdf$\nDisallow: /*?session=\n");
    expect(robotsAllows(rules, u("/menu.pdf"))).toBe(false);
    expect(robotsAllows(rules, u("/menu.pdf.html"))).toBe(true);
    expect(robotsAllows(rules, u("/prices?session=1"))).toBe(false);
  });

  it("allows everything with no file, and nothing when it can't be read", () => {
    expect(robotsFromResponse(404, "")).toBe(ALLOW_ALL);
    expect(robotsFromResponse(503, "")).toBe(DISALLOW_ALL);
    expect(robotsAllows(DISALLOW_ALL, u("/"))).toBe(false);
    expect(robotsAllows(ALLOW_ALL, u("/anything"))).toBe(true);
  });
});
