import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { METRIC_KEYS, MONEY_METRICS } from "../connectors/provider";
import { COMPONENT_KEYS } from "./opportunity";
import {
  ARCHETYPE_KEYS,
  CHART_ARCHETYPES,
  CHART_PROFILE_OF,
  SELLS_ARCHETYPE,
  archetypeFor,
  chartProfile,
} from "./profiles";

const bank = JSON.parse(readFileSync("specs/question-bank-v1.json", "utf8")) as {
  vocabularies: Record<string, string[]>;
};

describe("the chart profile table", () => {
  it("maps every bank business_type code somewhere, 'other' to the default row", () => {
    const types = bank.vocabularies["business_type"] ?? [];
    expect(types.length).toBeGreaterThan(0);
    for (const code of types) {
      expect(Object.hasOwn(CHART_PROFILE_OF, code), code).toBe(true);
      expect(ARCHETYPE_KEYS, code).toContain(CHART_PROFILE_OF[code]);
    }
    expect(CHART_PROFILE_OF["other"]).toBe("default");
  });

  it("names only codes the bank's vocabularies hold", () => {
    const types = bank.vocabularies["business_type"] ?? [];
    for (const code of Object.keys(CHART_PROFILE_OF)) expect(types, code).toContain(code);
    const sells = bank.vocabularies["sells_type"] ?? [];
    for (const code of Object.keys(SELLS_ARCHETYPE)) expect(sells, code).toContain(code);
  });

  it("every row is valid: money prices, count volumes, known components, an invitation", () => {
    for (const key of ARCHETYPE_KEYS) {
      const row = CHART_ARCHETYPES[key];
      expect(row.price.length, key).toBeGreaterThan(0);
      for (const p of row.price) {
        expect(METRIC_KEYS, key).toContain(p.metric);
        expect(MONEY_METRICS.has(p.metric), `${key} ${p.metric} is money`).toBe(true);
        expect(p.label.length).toBeGreaterThan(0);
        expect(p.noun).toBe(p.noun.toLowerCase());
        // A stock snapshot is not a daily flow and can never be a price.
        expect(p.metric.startsWith("stock.")).toBe(false);
      }
      expect(row.volume.length, key).toBeGreaterThan(0);
      for (const v of row.volume) {
        expect(METRIC_KEYS, key).toContain(v.metric);
        expect(MONEY_METRICS.has(v.metric), `${key} ${v.metric} is a count`).toBe(false);
        expect(v.metric.startsWith("stock.")).toBe(false);
        expect(v.word).toMatch(/^[a-z]+$/);
      }
      expect(new Set(row.components).size, `${key} has no duplicate component`).toBe(
        row.components.length,
      );
      for (const c of row.components) expect(COMPONENT_KEYS, key).toContain(c);
      expect(row.connect).toMatch(/I'll draw this$/);
      expect(row.why.length).toBeGreaterThan(20);
    }
  });

  it("prices the series the brief names: revenue for a shop or restaurant, bookings or revenue for a salon, gym or clinic", () => {
    expect(chartProfile("ecommerce_store").price[0]?.metric).toBe("revenue.daily");
    expect(chartProfile("restaurant").price[0]?.metric).toBe("revenue.daily");
    for (const code of ["salon_beauty", "gym_fitness", "clinic_health"]) {
      expect(chartProfile(code).price.map((p) => p.metric)).toEqual([
        "booking_revenue.daily",
        "revenue.daily",
      ]);
      expect(chartProfile(code).volume[0]?.word).toBe("appointments");
      expect(chartProfile(code).components[0]).toBe("no_shows");
    }
    expect(chartProfile("ecommerce_store").volume[0]?.word).toBe("orders");
  });

  it("only appointment rows price no-shows and capacity; a shop prices slow stock", () => {
    for (const key of ARCHETYPE_KEYS) {
      const has = CHART_ARCHETYPES[key].components.includes("empty_capacity");
      expect(has, key).toBe(key === "appointments" || key === "default");
    }
    expect(chartProfile("retail_shop").components).toContain("slow_stock");
    expect(chartProfile("cafe").components).not.toContain("slow_stock");
  });
});

describe("archetypeFor", () => {
  it("reads a bare code and an intake EnumValue alike", () => {
    expect(archetypeFor("salon_beauty")).toBe("appointments");
    expect(archetypeFor({ code: "barber" })).toBe("appointments");
  });

  it("falls to the default row for an unknown, malformed or missing type", () => {
    expect(archetypeFor("space_tourism")).toBe("default");
    expect(archetypeFor({ code: "other", label_raw: "Dog grooming van" })).toBe("default");
    expect(archetypeFor(null)).toBe("default");
    expect(archetypeFor(42)).toBe("default");
    expect(archetypeFor("toString")).toBe("default");
  });

  it("lets sells_type refine only the default row", () => {
    expect(archetypeFor("other", [{ code: "physical_products" }])).toBe("shop");
    expect(archetypeFor(null, ["physical_products", "services"])).toBe("shop");
    expect(archetypeFor(null, ["services"])).toBe("default");
    // A named type is never overridden by what it sells.
    expect(archetypeFor("salon_beauty", ["physical_products"])).toBe("appointments");
  });
});
