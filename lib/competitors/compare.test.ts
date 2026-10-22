// Feature 35 — their price beside yours: the match table and the arithmetic. Pure.

import { describe, expect, it } from "vitest";
import { money } from "../core/money";
import type { OwnOffer } from "./compare";
import { categoryOf, matchOffer, priceGap, similarity } from "./compare";

const own: OwnOffer[] = [
  { id: "o1", name: "Cut & colour", price: money(8500, "EUR") },
  { id: "o2", name: "Ladies haircut", price: money(5200, "EUR") },
  { id: "o3", name: "Gel manicure", price: null },
];

describe("price comparison arithmetic", () => {
  it("is theirs minus yours, in minor units, with a rounded percent", () => {
    const gap = priceGap(money(6900, "EUR"), money(8500, "EUR"));
    expect(gap).toMatchObject({ diff_minor: -1600, percent: -19, currency: "EUR" });
    expect(gap?.words).toBe("€16 below yours (−19%)");
    expect(priceGap(money(9000, "EUR"), money(8000, "EUR"))?.words).toBe("€10 above yours (+13%)");
    expect(priceGap(money(8500, "EUR"), money(8500, "EUR"))?.words).toBe("the same as yours");
  });

  it("keeps cents exact", () => {
    expect(priceGap(money(2499, "GBP"), money(2000, "GBP"))).toMatchObject({
      diff_minor: 499,
      words: "£4.99 above yours (+25%)",
    });
  });

  it("never converts: another currency has no gap", () => {
    expect(priceGap(money(2400000, "HUF"), money(6000, "EUR"))).toBeNull();
  });
});

describe("the match table", () => {
  it("matches by name first", () => {
    expect(matchOffer({ name: "Cut and colour" }, own)).toEqual({ offer: own[0], basis: "name" });
    expect(similarity("Ladies cut", "Ladies haircut")).toBeCloseTo(1 / 3);
  });

  it("falls back to the category", () => {
    expect(categoryOf("Balayage")).toBe("colour");
    expect(matchOffer({ name: "Balayage" }, own)).toEqual({ offer: own[0], basis: "category" });
    expect(matchOffer({ name: "Men's cut" }, own)).toEqual({ offer: own[1], basis: "category" });
    expect(matchOffer({ name: "Sports massage" }, own)).toBeNull();
  });

  it("lets the owner's correction win, including 'nothing of mine compares'", () => {
    expect(matchOffer({ name: "Balayage" }, own, "o2")).toEqual({ offer: own[1], basis: "owner" });
    expect(matchOffer({ name: "Cut and colour" }, own, "none")).toBeNull();
  });
});
