// Idea 43 — what-if pricing's arithmetic. What must hold: the break-even
// is exact at its boundary (one sale either side flips the answer), rests
// on no assumption, and says "at least" when the cost is unknown; every
// outcome is an ordered range in integer minor units, never below zero and
// never past the room in a booking business's book; a missing input is
// MISSING with where it's asked; a change outside the pinned bounds is
// refused; and the bands and windows agree with the figures they repeat.

import { describe, expect, it } from "vitest";
import { ARCHETYPE_KEYS } from "../charts/profiles";
import { BOOKING_WINDOW_DAYS } from "../bookings/measures";
import { SimulateError } from "./model";
import type { PriceItemRaw, PriceResult } from "./pricing";
import {
  PRICING,
  breakEven,
  changeError,
  comparePrices,
  newPriceOf,
  pricingHeadline,
  signedMoney,
  simulatePrice,
  volumeAfter,
} from "./pricing";
import { RESPONSE_BANDS } from "./pricing-bands";
import { ASK, offerItems, perOrderCosts, serviceItems } from "./pricing-items";

const ASKS = { price: ASK.offers, unit_cost: ASK.offers, volume: ASK.offers, capacity: null };

/** Fernhill's mug: €34, €9.80 to make, ~350 a month — all the owner's own figures. */
function mug(over: Partial<PriceItemRaw> = {}): PriceItemRaw {
  return {
    key: "offer:mug",
    kind: "offer",
    name: "Speckled Everyday Mug",
    currency: "EUR",
    price: { amount_minor: 3400, currency: "EUR", basis: "STATED", source: "as you told me" },
    unit_cost: { amount_minor: 980, currency: "EUR", basis: "STATED", source: "as you told me" },
    volume: { value: 350, basis: "STATED", source: "as you told me" },
    capacity: null,
    asks: ASKS,
    ...over,
  };
}

const rise10 = { kind: "share", share: 0.1 } as const;
const cut10 = { kind: "share", share: -0.1 } as const;

/** Profit on the item a month at a price and a volume, minor units. */
const profitAt = (price: number, cost: number, v: number) => v * (price - cost);

function cell(r: PriceResult, m: keyof PriceResult["measures"]) {
  const c = r.measures[m];
  if (c.status !== "range") throw new Error(`${m} is ${c.status}`);
  return c;
}

describe("the pinned bounds and bands", () => {
  it("every archetype has a band, gentle end below the strong end, both above zero", () => {
    for (const k of ARCHETYPE_KEYS) {
      const b = RESPONSE_BANDS[k];
      expect(b, k).toBeDefined();
      expect(b.low).toBeGreaterThan(0);
      expect(b.high).toBeGreaterThan(b.low);
    }
  });
  it("a booking business's window is the bookings measures' own 28 days", () => {
    expect(PRICING.horizon_days).toBe(BOOKING_WINDOW_DAYS);
  });
  it("every step the picker offers, and every default, is inside the bounds", () => {
    for (const s of [...PRICING.steps, ...PRICING.default_steps]) {
      expect(changeError(3400, { kind: "share", share: s }), String(s)).toBeNull();
    }
    expect(PRICING.default_steps.length).toBeLessThanOrEqual(PRICING.max_changes);
  });
});

describe("a change is held to the bounds", () => {
  it("accepts 1% and 30% either way", () => {
    expect(changeError(10_000, { kind: "share", share: 0.01 })).toBeNull();
    expect(changeError(10_000, { kind: "share", share: -0.3 })).toBeNull();
    expect(changeError(10_000, { kind: "exact", price_minor: 13_000 })).toBeNull();
  });
  it("refuses less than 1%, more than 30%, zero and the same price", () => {
    expect(changeError(10_000, { kind: "share", share: 0.005 })).toMatch(/too small/);
    expect(changeError(10_000, { kind: "share", share: 0.31 })).toMatch(/up to 30%/);
    expect(changeError(10_000, { kind: "exact", price_minor: 13_001 })).toMatch(/up to 30%/);
    expect(changeError(10_000, { kind: "exact", price_minor: 0 })).toMatch(/above zero/);
    expect(changeError(10_000, { kind: "exact", price_minor: 10_000 })).toMatch(/too small/);
  });
  it("rounds a share onto the price once, to integer minor units", () => {
    expect(newPriceOf(3400, rise10)).toBe(3740);
    expect(newPriceOf(3399, { kind: "share", share: 0.05 })).toBe(3569);
    expect(Number.isSafeInteger(newPriceOf(3399, { kind: "share", share: 0.05 }))).toBe(true);
  });
  it("simulatePrice throws a SimulateError on a change out of bounds", () => {
    expect(() => simulatePrice(mug(), { kind: "share", share: 0.5 }, "shop")).toThrow(
      SimulateError,
    );
  });
});

describe("the break-even of a rise", () => {
  const be = breakEven(mug(), 3740);
  it("is (P′ − P) ÷ (P′ − C) of the volume: 10% on €34 can lose fewer than 44 of ~350", () => {
    expect(be.status).toBe("lose");
    if (be.status !== "lose") return;
    expect(be.share).toBeCloseTo(340 / 2760, 10);
    expect(be.units).toBeCloseTo((350 * 340) / 2760, 10);
    expect(be.floor).toBe(false);
    expect(be.words).toBe(
      "A 10% rise pays as long as you lose fewer than 44 of your ~350 sales a month (12.3%).",
    );
  });
  it("holds at its boundary: losing 43 comes out ahead, losing 44 does not", () => {
    const today = profitAt(3400, 980, 350);
    expect(profitAt(3740, 980, 350 - 43)).toBeGreaterThan(today);
    expect(profitAt(3740, 980, 350 - 44)).toBeLessThan(today);
  });
  it("rests on the owner's figures only — no ASSUMED basis", () => {
    if (be.status !== "lose") throw new Error(be.status);
    expect(be.bases).toEqual(["STATED"]);
  });
  it("with no cost to deliver, is a floor that holds for any cost, and says so", () => {
    const floor = breakEven(mug({ unit_cost: null }), 3740);
    if (floor.status !== "lose") throw new Error(floor.status);
    expect(floor.floor).toBe(true);
    expect(floor.share).toBeCloseTo(340 / 3740, 10);
    expect(floor.words).toMatch(/^Whatever each one costs you to deliver/);
    // A floor: at any real cost the allowed loss is at least this big.
    for (const cost of [0, 500, 980, 2000, 3000]) {
      expect((3740 - 3400) / (3740 - cost)).toBeGreaterThanOrEqual(floor.share - 1e-12);
    }
  });
  it("with no volume, is a share of sales, not a count", () => {
    const be2 = breakEven(mug({ volume: null }), 3740);
    if (be2.status !== "lose") throw new Error(be2.status);
    expect(be2.units).toBeNull();
    expect(be2.words).toBe("A 10% rise pays as long as you lose fewer than 12.3% of your sales.");
  });
});

describe("the break-even of a cut", () => {
  it("is (P − P′) ÷ (P′ − C): 10% off €34 must win more than 57 extra sales", () => {
    const be = breakEven(mug(), 3060);
    if (be.status !== "win") throw new Error(be.status);
    expect(be.share).toBeCloseTo(340 / 2080, 10);
    expect(be.words).toBe(
      "A 10% cut pays only if you win more than 57 extra sales on your ~350 a month (+16.3%).",
    );
    const today = profitAt(3400, 980, 350);
    expect(profitAt(3060, 980, 350 + 58)).toBeGreaterThan(today);
    expect(profitAt(3060, 980, 350 + 57)).toBeLessThan(today);
  });
  it("never pays when the new price is under the cost to deliver", () => {
    const be = breakEven(mug({ unit_cost: { ...mug().unit_cost!, amount_minor: 3200 } }), 3060);
    expect(be.status).toBe("never");
    expect(be.status === "never" && be.words).toMatch(/no amount of extra sales/);
  });
  it("is missing without a cost — with the question that asks it — and gives only a lower bound", () => {
    const be = breakEven(mug({ unit_cost: null }), 3060);
    if (be.status !== "missing") throw new Error(be.status);
    expect(be.needs).toEqual([{ what: "what one costs you to deliver", href: "/intake?ask=3.1" }]);
    expect(be.words).toMatch(/at least 39 more/);
    expect(be.words).toMatch(/the true figure is higher/);
  });
  it("treats a cost in another currency as missing, never converted", () => {
    const gbp = mug({ unit_cost: { ...mug().unit_cost!, currency: "GBP" } });
    const r = simulatePrice(gbp, rise10, "shop");
    expect(r.breakeven.status === "lose" && r.breakeven.floor).toBe(true);
    const cost = r.inputs.find((i) => i.key === "unit_cost")!;
    expect(cost.basis).toBeNull();
    expect(cost.source).toMatch(/I don't convert between currencies/);
    expect(r.measures.profit.status).toBe("missing");
  });
});

describe("the outcomes under the band", () => {
  const band = RESPONSE_BANDS.shop;
  it("a rise: sales fall across the band, ordered, both ends at or below today", () => {
    const r = simulatePrice(mug(), rise10, "shop");
    const v = cell(r, "volume").range;
    expect(v.low).toBeLessThanOrEqual(v.high);
    expect(v.high).toBeLessThanOrEqual(350);
    expect(v).toEqual({
      low: Math.round(350 * (1 - 0.1 * band.high)),
      high: Math.round(350 * (1 - 0.1 * band.low)),
    });
  });
  it("profit is a range at the band's two ends, in integer minor units, worst = its low end", () => {
    const r = simulatePrice(mug(), rise10, "shop");
    const p = cell(r, "profit");
    const today = profitAt(3400, 980, 350);
    const at = (e: number) => Math.round(350 * (1 - 0.1 * e) * 2760 - today);
    expect(p.range).toEqual({ low: at(band.high), high: at(band.low) });
    expect(Number.isSafeInteger(p.range.low) && Number.isSafeInteger(p.range.high)).toBe(true);
    expect(p.range.low).toBeLessThan(0);
    expect(p.range.high).toBeGreaterThan(0);
    expect(p.bases).toContain("ASSUMED");
    const w = cell(r, "worst");
    expect(w.range.low).toBe(p.range.low);
    expect(w.exact).toBe(true);
    expect(r.worst_words).toMatch(/strong end of the band/);
  });
  it("a cut: sales rise across the band, both ends at or above today", () => {
    const r = simulatePrice(mug(), cut10, "shop");
    const v = cell(r, "volume").range;
    expect(v.low).toBeGreaterThanOrEqual(350);
    expect(v.low).toBeLessThanOrEqual(v.high);
    expect(r.worst_words).toMatch(/gentle end of the band/);
  });
  it("volume never goes below zero, however strong the response", () => {
    const { range } = volumeAfter(100, 0.3, { low: 1, high: 5, why: "" }, null);
    expect(range.low).toBe(0);
    expect(range.high).toBeCloseTo(70, 10);
  });
  it("with no volume, outcomes are MISSING with what fills them — never a number", () => {
    const r = simulatePrice(mug({ volume: null }), rise10, "shop");
    for (const m of ["volume", "revenue", "profit", "worst"] as const) {
      const c = r.measures[m];
      expect(c.status, m).toBe("missing");
      expect(c.status === "missing" && c.needs.join(" ")).toMatch(/how many/);
    }
  });
  it("with no cost, revenue is worked out and profit waits for the cost", () => {
    const r = simulatePrice(mug({ unit_cost: null }), rise10, "shop");
    expect(r.measures.revenue.status).toBe("range");
    expect(r.measures.profit.status).toBe("missing");
    const cost = r.inputs.find((i) => i.key === "unit_cost")!;
    expect(cost.needs?.href).toBe("/intake?ask=3.1");
  });
  it("the band is printed as ASSUMED with its source", () => {
    const r = simulatePrice(mug(), rise10, "shop");
    const resp = r.inputs.find((i) => i.key === "response")!;
    expect(resp.basis).toBe("ASSUMED");
    expect(resp.source).toMatch(/not a measurement/);
  });
});

describe("a missing price", () => {
  const priceless = mug({ price: null, currency: "" });
  it("is refused by the simulation and listed as refused in a comparison", () => {
    expect(() => simulatePrice(priceless, rise10, "shop")).toThrow(SimulateError);
    const cmp = comparePrices(priceless, [rise10], "shop");
    expect(cmp.results).toEqual([]);
    expect(cmp.refused[0]?.why).toMatch(/no price/);
  });
  it("makes the break-even MISSING, linked to the question", () => {
    const be = breakEven(priceless, 3740);
    expect(be.status === "missing" && be.needs[0]?.href).toBe("/intake?ask=3.1");
  });
});

describe("the side by side", () => {
  it("compares up to four changes and refuses a fifth", () => {
    const four = [0.05, 0.1, -0.05, -0.1].map((share) => ({ kind: "share", share }) as const);
    expect(comparePrices(mug(), four, "shop").results).toHaveLength(4);
    expect(() => comparePrices(mug(), [...four, { kind: "share", share: 0.2 }], "shop")).toThrow(
      SimulateError,
    );
  });
  it("collapses two changes that land on the same price, and lists an out-of-bounds one", () => {
    const cmp = comparePrices(
      mug(),
      [rise10, { kind: "exact", price_minor: 3740 }, { kind: "share", share: 0.9 }],
      "shop",
    );
    expect(cmp.results).toHaveLength(1);
    expect(cmp.refused).toHaveLength(1);
  });
  it("leads with the first rise's break-even", () => {
    const cmp = comparePrices(mug(), [cut10, rise10], "shop");
    expect(pricingHeadline(cmp)).toMatch(/^A 10% rise pays as long as you lose fewer than 44/);
  });
  it("prints whole signed money", () => {
    expect(signedMoney(41_720, "EUR")).toBe("+€417");
    expect(signedMoney(-74_200, "EUR")).toBe("−€742");
    expect(signedMoney(0, "EUR")).toBe("€0");
  });
});

describe("a booking business: a service against its own bookings", () => {
  const rows = [
    ...Array.from({ length: 60 }, () => ({
      service: "Cut & finish",
      status: "completed",
      price_minor: 5500,
      currency: "EUR",
    })),
    ...Array.from({ length: 40 }, () => ({
      service: "Colour",
      status: "completed",
      price_minor: 9000,
      currency: "EUR",
    })),
    // A no-show is not a sale and fills no slot that counts here.
    { service: "Colour", status: "no_show", price_minor: 9000, currency: "EUR" },
  ];
  const base = { rows, from: "2026-09-28", to: "2026-10-25", source: "your bookings export" };

  it("reads each service's price and volume from completed appointments, OBSERVED", () => {
    const items = serviceItems({ ...base, capacityPerWeek: 30, offers: [] });
    expect(items.map((i) => i.name)).toEqual(["Cut & finish", "Colour"]);
    const cut = items[0]!;
    expect(cut.price?.amount_minor).toBe(5500);
    expect(cut.price?.basis).toBe("OBSERVED");
    expect(cut.volume?.value).toBe(60);
    // 30 a week × 4 weeks = 120 slots, 100 completed → room for 20.
    expect(cut.capacity).toMatchObject({ slots: 120, taken: 100 });
    expect(cut.unit_cost).toBeNull();
    expect(cut.asks.unit_cost).toBe("/intake?ask=3.1");
  });

  it("a rise with no cost gives the floor, in bookings every 28 days", () => {
    const [cut] = serviceItems({ ...base, capacityPerWeek: 30, offers: [] });
    const r = simulatePrice(cut!, rise10, "appointments");
    expect(r.breakeven.status === "lose" && r.breakeven.words).toMatch(
      /lose fewer than 6 of your ~60 bookings every 28 days/,
    );
  });

  it("a cut can't win more bookings than the book has room for", () => {
    const offer = mug({
      name: "Cut & finish",
      unit_cost: { ...mug().unit_cost!, amount_minor: 800 },
    });
    const [cut] = serviceItems({ ...base, capacityPerWeek: 30, offers: [offer] });
    expect(cut!.unit_cost?.amount_minor).toBe(800);
    const r = simulatePrice(cut!, { kind: "share", share: -0.2 }, "appointments");
    // Needs 60 × 1100 ÷ 3600 = 18.3 more; the book has room for 20 — it fits.
    expect(r.breakeven.status === "win" && r.breakeven.room).toBe(20);
    expect(r.breakeven.status === "win" && r.breakeven.words).not.toMatch(/can't pay/);
    // A fuller book (25 a week → 0 room): the same cut can't pay from bookings.
    const [full] = serviceItems({ ...base, capacityPerWeek: 25, offers: [offer] });
    const r2 = simulatePrice(full!, { kind: "share", share: -0.2 }, "appointments");
    expect(r2.breakeven.status === "win" && r2.breakeven.words).toMatch(
      /room for 0 more in 28 days, so it can't pay from extra bookings alone/,
    );
    const v = cell(r2, "volume");
    expect(v.range).toEqual({ low: 60, high: 60 });
    expect(v.formula).toMatch(/held to the 0 more your book has room for/);
  });

  it("with no stated capacity, a cut says the extra bookings are assumed to fit", () => {
    const [cut] = serviceItems({ ...base, capacityPerWeek: null, offers: [] });
    expect(cut!.capacity).toBeNull();
    const r = simulatePrice(cut!, cut10, "appointments");
    expect(r.assumptions.map((a) => a.statement)).toContain("Extra bookings fit in the book.");
    const cap = r.inputs.find((i) => i.key === "capacity")!;
    expect(cap.needs?.href).toBe("/intake?ask=1.4.2.3b");
    // A rise needs no room, so it adds no such assumption.
    const up = simulatePrice(cut!, rise10, "appointments");
    expect(up.assumptions.map((a) => a.statement)).not.toContain("Extra bookings fit in the book.");
  });

  it("keeps services in different currencies apart", () => {
    const items = serviceItems({
      ...base,
      rows: [
        { service: "Cut", status: "completed", price_minor: 5000, currency: "EUR" },
        { service: "Cut", status: "completed", price_minor: 4500, currency: "GBP" },
      ],
      capacityPerWeek: null,
      offers: [],
    });
    expect(items.map((i) => i.currency).sort()).toEqual(["EUR", "GBP"]);
  });
});

describe("the offers on a profile snapshot", () => {
  const f = (value: unknown, source: unknown = { kind: "owner_input" }) =>
    ({ value, status: "answered", source, note: null, confidence: "0.750" }) as unknown;
  const facts = new Map<string, unknown>([
    ["offers.a.name", f("Mug")],
    ["offers.a.price", f({ amount_minor: 3400, currency: "EUR" })],
    ["offers.a.cost_to_deliver", f({ amount_minor: 980, currency: "EUR" })],
    [
      "offers.a.volume_period",
      {
        value: 312,
        status: "inferred",
        source: { kind: "connector", provider: "shopify" },
        note: "Measured from Shopify.",
        confidence: "0.950",
      },
    ],
    ["offers.b.name", f("Old jug")],
    ["offers.b.price", f({ amount_minor: 2000, currency: "EUR" })],
    ["offers.b.lifecycle", f("discontinued")],
    ["offers.c.name", f("Gift card")],
    ["costs.x.label", f("Courier label per parcel")],
    ["costs.x.amount", f({ amount_minor: 740, currency: "EUR" })],
    ["costs.x.cadence", f("per_job")],
    ["costs.y.label", f("Rent")],
    ["costs.y.amount", f({ amount_minor: 145_000, currency: "EUR" })],
    ["costs.y.cadence", f("monthly")],
  ]);
  const view = {
    summary: {},
    facts,
    entities: [
      { spine: "offers", id: "a", kind: "physical" },
      { spine: "offers", id: "b", kind: "physical" },
      { spine: "offers", id: "c", kind: "digital" },
      { spine: "cost_items", id: "x", kind: "variable" },
      { spine: "cost_items", id: "y", kind: "fixed" },
    ],
  } as unknown as Parameters<typeof offerItems>[0];

  it("reads each offer's figures with their basis, and leaves out a discontinued one", () => {
    const items = offerItems(view);
    expect(items.map((i) => i.name)).toEqual(["Mug", "Gift card"]);
    const m = items[0]!;
    expect(m.price).toMatchObject({
      amount_minor: 3400,
      basis: "STATED",
      source: "as you told me",
    });
    expect(m.volume).toMatchObject({
      value: 312,
      basis: "OBSERVED",
      source: "Measured from Shopify.",
    });
  });
  it("keeps an offer with no price, so the screen can say it's missing", () => {
    const card = offerItems(view)[1]!;
    expect(card.price).toBeNull();
    expect(card.asks.price).toBe("/intake?ask=3.1");
  });
  it("lists per-order costs only — a monthly cost is not a per-order one", () => {
    expect(perOrderCosts(view)).toEqual([
      { label: "Courier label per parcel", amount_minor: 740, currency: "EUR" },
    ]);
  });
});
