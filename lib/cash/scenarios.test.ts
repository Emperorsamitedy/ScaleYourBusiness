// P5-09 — cash scenarios side by side, pure: each runs the same forecast
// with one change, each is a range, the defaults come from the business's
// own numbers, and a scenario without its figure says what would fill it.

import { describe, expect, it } from "vitest";
import type { PriceItemRaw } from "../simulate/pricing";
import { simulatePrice } from "../simulate/pricing";
import { TODAY, baseInputs, cost, daily, eur, offer } from "./fixtures";
import type { CashInputs, CashReady } from "./model";
import { forecastCash } from "./model";
import {
  SCENARIO,
  compareScenarios,
  defaultChoice,
  parseChoice,
  priceEffect,
  runScenario,
} from "./scenarios";

function plainOf(inputs: CashInputs): CashReady {
  const f = forecastCash(inputs);
  if (f.status !== "ready") throw new Error(f.headline);
  return f;
}

const inputs = baseInputs({
  costs: [
    cost("Rent", 1200, "monthly"),
    cost("Assistant", 1900, "monthly", { category: "salaries" }),
  ],
});
const plain = plainOf(inputs);

describe("P5-09 — the pinned bounds", () => {
  it("a slow month is 4 weeks at 20%, held to 5–60%; the big order opens in week 5", () => {
    expect(SCENARIO).toMatchObject({
      slow_weeks: 4,
      slow_share: 0.2,
      min_slow_share: 0.05,
      max_slow_share: 0.6,
      order_week: 4,
    });
  });
});

describe("P5-09 — each scenario through the same forecast", () => {
  it("a slow month: 20% less for four weeks, nothing else moves", () => {
    const r = runScenario(inputs, plain, { kind: "slow_month", share: 0.2, start_week: 0 });
    expect(r.forecast.weeks[0]?.sales.low).toBe(560_000);
    expect(r.forecast.weeks[4]?.sales.low).toBe(700_000);
    expect(r.vs_plain).toEqual({ low: -560_000, high: -560_000 });
    expect(r.title).toBe("A slow month (−20%)");
  });

  it("a big order: in full that week, less its per-sale costs at the forecast's own share", () => {
    const withCosts = baseInputs({ offers: [offer("Mug", 10, 3, 100)] });
    const p = plainOf(withCosts);
    const r = runScenario(withCosts, p, { kind: "big_order", amount_minor: 700_000, week: 4 });
    expect(r.forecast.weeks[3]?.balance).toEqual(p.weeks[3]?.balance);
    // +7,000 − 30% × 7,000.
    expect(r.forecast.weeks[4]!.balance.low - p.weeks[4]!.balance.low).toBe(490_000);
  });

  it("a hire: its monthly cost on each 1st from its week", () => {
    const r = runScenario(inputs, plain, { kind: "hire", monthly_minor: 190_000, from_week: 0 });
    // 1 Nov, 1 Dec, 1 Jan.
    expect(r.vs_plain).toEqual({ low: -570_000, high: -570_000 });
    const later = runScenario(inputs, plain, {
      kind: "hire",
      monthly_minor: 190_000,
      from_week: 6,
    });
    expect(later.vs_plain.low).toBe(-190_000); // only 1 Jan falls after week 6 starts
  });

  it("a price change: what-if pricing's weekly profit range, both ends carried", () => {
    const r = runScenario(inputs, plain, {
      kind: "price",
      effect: {
        title: "+5%",
        weekly: { low: -10_000, high: 30_000 },
        currency: "EUR",
        source: "band",
      },
    });
    expect(r.vs_plain).toEqual({ low: -130_000, high: 390_000 });
    expect(r.end.low).toBeLessThan(r.end.high);
  });

  it("a scenario can bring a tight week the plain forecast doesn't have", () => {
    expect(
      runScenario(inputs, plain, { kind: "slow_month", share: 0.2, start_week: 0 }).tight,
    ).toBeNull();
    const r = runScenario(inputs, plain, { kind: "hire", monthly_minor: 700_000, from_week: 0 });
    expect(r.tight?.index).toBe(0);
  });
});

describe("P5-09 — sizes from the business's own numbers, or a named gap", () => {
  it("defaults: a typical week as the big order, the largest stated salary as the hire", () => {
    expect(defaultChoice(inputs, plain)).toEqual({
      slow_share: 0.2,
      slow_week: 0,
      order_minor: 700_000,
      order_week: 4,
      hire_minor: 190_000,
      hire_week: 0,
    });
  });

  it("no salary stated: the hire is a missing cell that says what fills it, not a guess", () => {
    const bare = baseInputs();
    const p = plainOf(bare);
    const cells = compareScenarios(bare, p, defaultChoice(bare, p), null);
    expect(cells.map((c) => [c.status, c.status === "ready" ? c.result.kind : c.kind])).toEqual([
      ["ready", "slow_month"],
      ["ready", "big_order"],
      ["missing", "hire"],
      ["missing", "price"],
    ]);
  });

  it("the owner's figures, held to the bounds; anything out of bounds falls back to the default", () => {
    const d = defaultChoice(inputs, plain);
    expect(
      parseChoice({ slow: "30", order: "2500", order_week: "2", hire: "1200.50" }, d, 2),
    ).toEqual({
      ...d,
      slow_share: 0.3,
      order_minor: 250_000,
      order_week: 2,
      hire_minor: 120_050,
    });
    expect(parseChoice({ slow: "70", order: "-5", order_week: "13", hire: "abc" }, d, 2)).toEqual(
      d,
    );
  });

  it("a price change in another currency is refused, not converted", () => {
    const cells = compareScenarios(inputs, plain, defaultChoice(inputs, plain), {
      title: "+5%",
      weekly: { low: 1, high: 2 },
      currency: "USD",
      source: "band",
    });
    expect(cells[3]).toMatchObject({ status: "missing", kind: "price" });
  });
});

describe("P5-09 — what-if pricing's result as a weekly effect", () => {
  const item: PriceItemRaw = {
    key: "offer:mug",
    kind: "offer",
    name: "Mug",
    currency: "EUR",
    price: { amount_minor: 3400, currency: "EUR", basis: "STATED", source: "as you told me" },
    unit_cost: { amount_minor: 1100, currency: "EUR", basis: "STATED", source: "as you told me" },
    volume: { value: 200, basis: "STATED", source: "as you told me" },
    capacity: null,
    asks: { price: "/x", unit_cost: "/x", volume: "/x", capacity: null },
  };

  it("an offer's monthly profit change × 12 ÷ 52, both ends", () => {
    const r = simulatePrice(item, { kind: "share", share: 0.05 }, "shop");
    const e = priceEffect(r, item)!;
    expect(r.measures.profit.status).toBe("range");
    if (r.measures.profit.status !== "range") return;
    expect(e.weekly).toEqual({
      low: Math.round((r.measures.profit.range.low * 12) / 52),
      high: Math.round((r.measures.profit.range.high * 12) / 52),
    });
    expect(e.title).toMatch(/on Mug$/);
  });

  it("no cost to deliver means no profit range, so no price scenario", () => {
    const r = simulatePrice({ ...item, unit_cost: null }, { kind: "share", share: 0.05 }, "shop");
    expect(priceEffect(r, item)).toBeNull();
    expect(eur(1).currency).toBe("EUR");
    expect(daily(TODAY, 1, () => 1).values.size).toBe(1);
  });
});
