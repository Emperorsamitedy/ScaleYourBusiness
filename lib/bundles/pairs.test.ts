import { describe, expect, it } from "vitest";
import type { Basket, VisitAppointment } from "./pairs";
import { BUNDLES, minePairs, pairMargin, visitsOf } from "./pairs";

/** n copies of one basket. */
const times = (n: number, items: string[]): Basket[] =>
  Array.from({ length: n }, () => ({ items }));

describe("support, confidence and lift", () => {
  // 100 orders: 10 pour-over sets, 8 of them with a vase; 20 vases in all;
  // the rest are mugs alone.
  const baskets = [
    ...times(8, ["pourover", "vase"]),
    ...times(2, ["pourover"]),
    ...times(12, ["vase"]),
    ...times(78, ["mug"]),
  ];

  it("measures a pair against chance", () => {
    const r = minePairs(baskets);
    if (r.status !== "mined") throw new Error(r.status);
    expect(r.baskets).toBe(100);
    expect(r.multi).toBe(8);
    const p = r.pairs[0]!;
    // The rarer item is A: 80% of orders with a pour-over set had a vase.
    expect([p.a, p.b]).toEqual(["pourover", "vase"]);
    expect(p.together).toBe(8);
    expect(p.support).toBeCloseTo(0.08);
    expect(p.confidence).toBeCloseTo(0.8);
    expect(p.confidence_ba).toBeCloseTo(0.4);
    // Chance: 10 × 20 ÷ 100 = 2 orders; 8 is 4× that.
    expect(p.expected).toBeCloseTo(2);
    expect(p.lift).toBeCloseTo(4);
  });

  it("counts every distinct item once per basket", () => {
    const r = minePairs([...times(6, ["a", "a", "b"]), ...times(60, ["c"])]);
    if (r.status !== "mined") throw new Error(r.status);
    expect(r.pairs[0]!.together).toBe(6);
    expect(r.pairs[0]!.count_a).toBe(6);
  });
});

describe("the thresholds keep noise off the screen", () => {
  it("refuses to mine fewer baskets than the minimum", () => {
    const r = minePairs(times(BUNDLES.min_baskets - 1, ["a", "b"]));
    expect(r).toEqual({
      status: "too_few",
      baskets: BUNDLES.min_baskets - 1,
      multi: BUNDLES.min_baskets - 1,
      needed: BUNDLES.min_baskets,
    });
    expect(minePairs(times(BUNDLES.min_baskets, ["a", "b"])).status).toBe("mined");
  });

  it("drops a pair seen in fewer baskets than min_together, however strong", () => {
    const few = [...times(BUNDLES.min_together - 1, ["a", "b"]), ...times(80, ["c"])];
    const r = minePairs(few);
    if (r.status !== "mined") throw new Error(r.status);
    expect(r.pairs).toEqual([]);
    expect(r.below_count).toBe(1);
    const enough = [...times(BUNDLES.min_together, ["a", "b"]), ...times(80, ["c"])];
    const r2 = minePairs(enough);
    if (r2.status !== "mined") throw new Error(r2.status);
    expect(r2.pairs).toHaveLength(1);
  });

  it("drops a frequent pair that comes up no more often than chance", () => {
    // Half the orders hold a, half hold b, independently: lift 1.0.
    const independent = [
      ...times(25, ["a", "b"]),
      ...times(25, ["a"]),
      ...times(25, ["b"]),
      ...times(25, ["c"]),
    ];
    const r = minePairs(independent);
    if (r.status !== "mined") throw new Error(r.status);
    expect(r.pairs).toEqual([]);
    expect(r.below_lift).toBe(1);
  });

  it("keeps a pair just at the lift line, and drops one just under it", () => {
    // a: 20, b: 50, n: 100 → chance 10. 12 together is 1.2×; 11 is 1.1×.
    const make = (both: number) => [
      ...times(both, ["a", "b"]),
      ...times(20 - both, ["a"]),
      ...times(50 - both, ["b"]),
      ...times(100 - (20 + 50 - both), ["c"]),
    ];
    const at = minePairs(make(12));
    const under = minePairs(make(11));
    if (at.status !== "mined" || under.status !== "mined") throw new Error("not mined");
    expect(at.pairs[0]!.lift).toBeCloseTo(1.2);
    expect(under.pairs).toEqual([]);
  });

  it("shows at most max_pairs, most often together first", () => {
    const baskets: Basket[] = [];
    for (let i = 0; i < 8; i++) baskets.push(...times(5 + i, [`x${i}`, `y${i}`]));
    baskets.push(...times(200, ["filler"]));
    const r = minePairs(baskets);
    if (r.status !== "mined") throw new Error(r.status);
    expect(r.passed).toBe(8);
    expect(r.pairs).toHaveLength(BUNDLES.max_pairs);
    expect(r.pairs[0]!.together).toBe(12);
  });
});

describe("a bookings business: services added on in one visit", () => {
  it("groups one client's completed appointments on one day", () => {
    const { visits, ungrouped } = visitsOf([
      { day: "2026-10-20", client_key: "k1", service: "Colour", status: "completed" },
      { day: "2026-10-20", client_key: "k1", service: "Treatment", status: "completed" },
      { day: "2026-10-21", client_key: "k1", service: "Cut & finish", status: "completed" },
      { day: "2026-10-20", client_key: "k2", service: "Colour", status: "no_show" },
      { day: "2026-10-20", client_key: null, service: "Blow-dry", status: "completed" },
    ]);
    expect(visits.map((v) => [...v.items].sort())).toEqual([
      ["Colour", "Treatment"],
      ["Cut & finish"],
    ]);
    // A no-show isn't a visit; an appointment with no client can't be grouped.
    expect(ungrouped).toBe(1);
  });

  it("finds an add-on from visits, and leaves a popular service's chance pairing out", () => {
    const appts: VisitAppointment[] = [];
    let c = 0;
    const visit = (services: string[]) => {
      c++;
      for (const s of services)
        appts.push({ day: "2026-10-20", client_key: `k${c}`, service: s, status: "completed" });
    };
    for (let i = 0; i < 30; i++) visit(["Colour", "Treatment"]);
    for (let i = 0; i < 30; i++) visit(["Colour"]);
    for (let i = 0; i < 6; i++) visit(["Colour", "Cut & finish"]);
    for (let i = 0; i < 134; i++) visit(["Cut & finish"]);
    const r = minePairs(visitsOf(appts).visits);
    if (r.status !== "mined") throw new Error(r.status);
    expect(r.pairs.map((p) => [p.a, p.b])).toEqual([["Treatment", "Colour"]]);
    expect(r.pairs[0]!.confidence).toBe(1);
    // Colour with a cut: seen 6 times, but less often than chance.
    expect(r.below_lift).toBe(1);
  });
});

describe("the pair's margin", () => {
  const plate = {
    name: "Plate",
    economics: { price_minor: 4200, cost_minor: 1250, currency: "EUR" },
  };
  const bowl = {
    name: "Bowl",
    economics: { price_minor: 8900, cost_minor: 2600, currency: "EUR" },
  };

  it("adds each item's price less cost, over both prices", () => {
    const m = pairMargin(plate, bowl);
    expect(m).toMatchObject({
      known: true,
      currency: "EUR",
      price_minor: 13_100,
      contribution_minor: 9_250,
      margin_pct: 70.6,
    });
  });

  it("is unknown, not assumed, without a cost or a price", () => {
    const noCost = {
      name: "Vase",
      economics: { price_minor: 4800, cost_minor: null, currency: "EUR" },
    };
    expect(pairMargin(plate, noCost)).toEqual({
      known: false,
      why: "no cost on record for Vase, so the margin is unknown rather than assumed",
    });
    expect(pairMargin(plate, { name: "Gift Card", economics: null })).toEqual({
      known: false,
      why: "no price on record for Gift Card",
    });
  });

  it("never adds two currencies", () => {
    const huf = {
      name: "Mug",
      economics: { price_minor: 900_00, cost_minor: 300_00, currency: "HUF" },
    };
    expect(pairMargin(plate, huf)).toEqual({
      known: false,
      why: "their prices are in different currencies",
    });
  });
});
