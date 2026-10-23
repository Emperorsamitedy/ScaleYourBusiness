// Feature 35 — robots.txt, RFC 9309. Pure.

import { describe, expect, it } from "vitest";
import {
  ALLOW_ALL,
  DISALLOW_ALL,
  MAX_WILDCARDS_PER_RULE,
  parseRobots,
  robotsAllows,
  robotsFromResponse,
  robotsPatternMatches,
} from "./robots";

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

  it("matches wildcards exactly: pieces in order, $ only at the end", () => {
    expect(robotsPatternMatches("/a*b*c", "/axxbyyc")).toBe(true);
    expect(robotsPatternMatches("/a*b*c", "/axxcyyb")).toBe(false);
    expect(robotsPatternMatches("/a*c$", "/abcbc")).toBe(true);
    expect(robotsPatternMatches("/a*c$", "/abcb")).toBe(false);
    expect(robotsPatternMatches("/ab*b$", "/ab")).toBe(false); // the pieces may not overlap
    expect(robotsPatternMatches("/ab*b$", "/abb")).toBe(true);
    expect(robotsPatternMatches("/x$", "/x")).toBe(true);
    expect(robotsPatternMatches("/x$", "/xy")).toBe(false);
    expect(robotsPatternMatches("*", "/anything")).toBe(true);
    expect(robotsPatternMatches("/p", "/q")).toBe(false);
  });

  it("finding 2 (review 2026-10-23): a hostile pattern finishes at once and is ignored past the cap", () => {
    const hostile = `/${"*a".repeat(30)}*b`;
    const path = `/${"a".repeat(5_000)}`;
    const rules = parseRobots(`User-agent: *\nDisallow: ${hostile}\nDisallow: /*a*a*a*a*a*b\n`);
    const started = performance.now();
    expect(robotsAllows(rules, u(path))).toBe(true); // neither rule matches: there is no "b"
    expect(robotsPatternMatches("/*a*a*a*a*a*a*a*a*a*b", path)).toBe(false);
    expect(performance.now() - started).toBeLessThan(50);
    // More stars than any real file uses: the rule is not run at all.
    const many = `/${"*x".repeat(MAX_WILDCARDS_PER_RULE + 1)}`;
    expect(robotsPatternMatches(many, `/${"x".repeat(20)}`)).toBe(false);
    expect(
      robotsPatternMatches(`/${"*x".repeat(MAX_WILDCARDS_PER_RULE)}`, `/${"x".repeat(20)}`),
    ).toBe(true);
  });
});
