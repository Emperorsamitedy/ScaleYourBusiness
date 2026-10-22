// Feature 34 — the cheapest ways to clear it, and the ranking arithmetic:
// cash likely back per euro given up, with zero-cost options first.

import { describe, expect, it } from "vitest";
import type { StockItem } from "./assess";
import type { OptionContext } from "./options";
import { CLEARANCE, clearanceOptions, efficiencyLine, rankOptions } from "./options";

const fmt = (m: number) => `€${(m / 100).toFixed(2)}`;

const item: StockItem = {
  provider: "shopify",
  connection_id: "c1",
  ref: "p1",
  name: "Large Serving Bowl",
  as_of: "2026-10-22",
  on_hand: 40,
  value_at_cost: 40 * 2_600, // €1,040.00
  value_at_price: 40 * 8_900, // €3,560.00
  currency: "EUR",
  cost_basis: "measured",
  offer_id: null,
  sales: { kind: "series", covered_days: 365, daily: new Map() },
};

const ctx: OptionContext = {
  best_seller: { name: "Speckled Everyday Mug", on_hand: 6 },
  content_channel: "instagram",
  emailable: 200,
  email_off: null,
  fmt,
};

const byKey = (opts: ReturnType<typeof clearanceOptions>) =>
  Object.fromEntries(opts.map((o) => [o.key, o]));

describe("the five options, each with its arithmetic", () => {
  const o = byKey(clearanceOptions(item, ctx));

  it("a post: 5–15% of 40 at full price, nothing given up", () => {
    expect(o.content!.units).toEqual({ low: 2, high: 6, expected: 4 });
    expect(o.content!.recovered).toEqual({ low: 17_800, high: 53_400, expected: 35_600 });
    expect(o.content!.given_up.expected).toBe(0);
    expect(o.content!.per_euro).toBeNull();
    expect(o.content!.arithmetic).toContain("40 on hand × 5%–15%");
  });

  it("a pairing is capped by the best seller's own stock", () => {
    // 10–25% of 40 = 4–10 units, capped at the 6 mugs on hand.
    expect(o.bundle!.units).toEqual({ low: 4, high: 6, expected: 5 });
    expect(o.bundle!.arithmetic).toContain("capped at 6 Speckled Everyday Mug on hand");
  });

  it("an email: 1–3% of 200 customers buying one", () => {
    expect(o.email!.units).toEqual({ low: 2, high: 6, expected: 4 });
    expect(o.email!.reversibility.level).toBe("hard");
  });

  it("a markdown gives up 25% of the full price on what it sells", () => {
    // 30–60% of 40 = 12–24 units at €66.75.
    expect(o.markdown!.units).toEqual({ low: 12, high: 24, expected: 18 });
    expect(o.markdown!.recovered).toEqual({ low: 80_100, high: 160_200, expected: 120_150 });
    expect(o.markdown!.given_up).toEqual({ low: 26_700, high: 53_400, expected: 40_050 });
    expect(o.markdown!.per_euro).toBeCloseTo(3, 5);
  });

  it("a sell-off recovers 20–40% of cost and gives up the rest of the full price", () => {
    expect(o.selloff!.recovered).toEqual({ low: 20_800, high: 41_600, expected: 31_200 });
    expect(o.selloff!.given_up).toEqual({ low: 314_400, high: 335_200, expected: 324_800 });
    expect(o.selloff!.per_euro).toBeCloseTo(31_200 / 324_800, 6);
    expect(o.selloff!.reversibility.if_you_change_your_mind).toMatch(/Advice only/);
  });
});

describe("the ranking — cash likely back per euro given up", () => {
  it("zero-cost options first by cash back, then costed ones by their ratio", () => {
    const ranked = rankOptions(clearanceOptions(item, ctx));
    // The pairing's 5 units (€445) lead; the post and the email tie at 4 units (€356) and keep
    // the cheapest-first order; then the markdown (3.00) beats the sell-off (0.10).
    expect(ranked.map((o) => o.key)).toEqual(["bundle", "content", "email", "markdown", "selloff"]);
  });

  it("an option that can't be proposed sinks to the end, saying why", () => {
    const ranked = rankOptions(
      clearanceOptions(item, { ...ctx, best_seller: null, content_channel: null, emailable: 0 }),
    );
    expect(ranked.map((o) => o.key)).toEqual(["markdown", "selloff", "content", "bundle", "email"]);
    expect(ranked.find((o) => o.key === "bundle")!.unavailable).toBe(
      "no best seller with stock to pair it with",
    );
    expect(ranked.find((o) => o.key === "email")!.unavailable).toBe(
      "no customer has said yes to email yet",
    );
  });

  it("a higher ratio outranks a lower one among costed options", () => {
    const ranked = rankOptions(
      clearanceOptions(item, { ...ctx, best_seller: null, content_channel: null, emailable: 0 }),
    ).filter((o) => o.unavailable === null);
    expect(ranked[0]!.per_euro!).toBeGreaterThan(ranked[1]!.per_euro!);
  });

  it("states the arithmetic of the ratio in words", () => {
    const md = clearanceOptions(item, ctx).find((o) => o.key === "markdown")!;
    expect(efficiencyLine(md, fmt)).toBe(
      "€1201.50 likely back ÷ €400.50 given up = 3.00 back for every 1 given up",
    );
    const post = clearanceOptions(item, ctx).find((o) => o.key === "content")!;
    expect(efficiencyLine(post, fmt)).toBe("€356.00 likely back, nothing given up");
  });

  it("no price, no estimate: every option that needs one says so", () => {
    const opts = clearanceOptions({ ...item, value_at_price: null }, ctx);
    for (const key of ["content", "bundle", "email", "markdown"]) {
      expect(opts.find((o) => o.key === key)!.unavailable).toBe("its selling price isn't known");
    }
  });

  it("the rates are pinned", () => {
    expect(CLEARANCE.markdown_share).toBe(0.25);
    expect(CLEARANCE.max_items).toBe(3);
  });
});
