// Idea 43 - the what-if pricing screen's words. A gap is a flag, never a
// number; the side by side holds to four changes; an exact price is read
// in the item's own currency's minor units; the screen opens on the most
// complete item; per-order costs are named, never silently counted.

import { describe, expect, it } from "vitest";
import type { PriceItemRaw, PricingInputs } from "../../lib/simulate/pricing";
import { PRICING, breakEven, comparePrices } from "../../lib/simulate/pricing";
import { whiskerChart } from "./view";
import {
  breakEvenView,
  defaultChanges,
  defaultItem,
  exactToMinor,
  itemLine,
  perOrderLine,
  stepLabel,
  toggleChange,
} from "./pricing-view";

const ASKS = {
  price: "/intake?ask=3.1",
  unit_cost: "/intake?ask=3.1",
  volume: "/intake?ask=3.1",
  capacity: null,
};

const item = (over: Partial<PriceItemRaw> = {}): PriceItemRaw => ({
  key: "offer:mug",
  kind: "offer",
  name: "Mug",
  currency: "EUR",
  price: { amount_minor: 3400, currency: "EUR", basis: "STATED", source: "as you told me" },
  unit_cost: { amount_minor: 980, currency: "EUR", basis: "STATED", source: "as you told me" },
  volume: { value: 350, basis: "STATED", source: "as you told me" },
  capacity: null,
  asks: ASKS,
  ...over,
});

const inputs = (items: PriceItemRaw[]): PricingInputs => ({
  as_of: "2026-10-26",
  currency: "EUR",
  archetype: "shop",
  items,
  per_order_costs: [
    { label: "Courier label per parcel", amount_minor: 740, currency: "EUR" },
    { label: "A dollar fee", amount_minor: 100, currency: "USD" },
  ],
});

describe("the break-even cell", () => {
  it("a rise reads 'Lose fewer than N' with its share of the volume", () => {
    expect(breakEvenView(breakEven(item(), 3740), item())).toEqual({
      figure: "Lose fewer than 44",
      sub: "12.3% of ~350",
      flag: null,
    });
  });
  it("a floor says it holds whatever the cost", () => {
    const i = item({ unit_cost: null });
    expect(breakEvenView(breakEven(i, 3740), i).sub).toMatch(/at least, whatever it costs you/);
  });
  it("a cut reads 'Win more than N'", () => {
    expect(breakEvenView(breakEven(item(), 3060), item()).figure).toBe("Win more than 57");
  });
  it("a gap is MISSING with a dash, never a number", () => {
    const i = item({ unit_cost: null });
    const v = breakEvenView(breakEven(i, 3060), i);
    expect(v).toMatchObject({ figure: "-", flag: "MISSING" });
  });
  it("a cut under the cost is NEVER", () => {
    const i = item({ unit_cost: { ...item().unit_cost!, amount_minor: 3200 } });
    expect(breakEvenView(breakEven(i, 3060), i).flag).toBe("NEVER");
  });
});

describe("the picks", () => {
  it("opens on +5%, +10% and −10%, inside the maximum", () => {
    expect(defaultChanges().map((c) => c.kind === "share" && c.share)).toEqual([0.05, 0.1, -0.1]);
  });
  it("holds the side by side to four, and a second press removes a change", () => {
    let picks = defaultChanges();
    picks = toggleChange(picks, { kind: "share", share: 0.2 });
    expect(picks).toHaveLength(PRICING.max_changes);
    expect(toggleChange(picks, { kind: "share", share: -0.2 })).toHaveLength(PRICING.max_changes);
    expect(toggleChange(picks, { kind: "share", share: 0.2 })).toHaveLength(3);
  });
  it("labels steps with a true minus", () => {
    expect(stepLabel(0.1)).toBe("+10%");
    expect(stepLabel(-0.05)).toBe("−5%");
  });
  it("reads an exact price into minor units of the item's currency", () => {
    expect(exactToMinor("36.50", "EUR")).toBe(3650);
    expect(exactToMinor("36,5", "EUR")).toBe(3650);
    expect(exactToMinor("4090", "JPY")).toBe(4090);
    expect(exactToMinor("abc", "EUR")).toBeNull();
    expect(exactToMinor("0", "EUR")).toBeNull();
  });
  it("opens on the most complete item", () => {
    const thin = item({ key: "offer:thin", volume: null, unit_cost: null });
    const none = item({ key: "offer:none", price: null });
    expect(defaultItem(inputs([none, thin, item()]))?.key).toBe("offer:mug");
    expect(defaultItem(inputs([]))).toBeNull();
  });
});

describe("the words around it", () => {
  it("an item's line says what's known and what isn't", () => {
    expect(itemLine(item())).toBe("€34 · ~350 sales a month · costs €9.80 to deliver");
    expect(itemLine(item({ price: null, volume: null, unit_cost: null }))).toBe(
      "no price yet · sales not known · cost to deliver not known",
    );
  });
  it("names per-order costs in the item's currency only, and only for a product", () => {
    const line = perOrderLine(inputs([item()]), item())!;
    expect(line).toMatch(/Courier label per parcel \(€7.40\)/);
    expect(line).not.toMatch(/dollar/);
    expect(perOrderLine(inputs([item()]), item({ kind: "service" }))).toBeNull();
  });
  it("the whiskers draw price changes on one axis through zero", () => {
    const cmp = comparePrices(item(), defaultChanges(), "shop");
    const chart = whiskerChart(cmp.results);
    expect(chart?.rows).toHaveLength(3);
    expect(chart!.zero).toBeGreaterThan(0);
    expect(chart!.zero).toBeLessThan(100);
  });
});
