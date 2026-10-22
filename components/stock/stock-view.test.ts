// Feature 34 — the slow-stock screen's words, and who the screen exists for.

import { describe, expect, it } from "vitest";
import type { StockItemView, StockView } from "../../app/api/stock/route";
import type { FieldView } from "../../lib/conditions/evaluate";
import { evaluate } from "../../lib/conditions/evaluate";
import { STOCK_APPLIES } from "../../lib/stock/applies";
import { GROUPS, visibleGroups } from "../nav/AppFrame";
import type { NavCounts } from "../../app/api/nav/route";
import { coverText, headline, proposalWord, quietText, statedVsMeasured } from "./stock-view";

const item = (over: Partial<StockItemView> = {}): StockItemView => ({
  key: "c:p",
  name: "Large Serving Bowl",
  source: "Shopify",
  as_of: "2026-10-22",
  on_hand: 40,
  sold: { 30: 0, 60: 0, 90: 0 },
  days_of_cover: null,
  days_since_sale: null,
  no_sale_for_at_least: 120,
  cash_tied_minor: 104_000,
  value_at_price_minor: 356_000,
  currency: "EUR",
  cost_basis: "measured",
  flag: "STUCK",
  why: "no sale in the 120 days on record",
  proposed_for: true,
  options: [],
  ...over,
});

const view = (over: Partial<StockView> = {}): StockView => ({
  applies: true,
  sources: [{ label: "Shopify", as_of: "2026-10-22", items: 3 }],
  slow: [item()],
  totals: [{ currency: "EUR", cash_tied_minor: 104_000, items: 1, unknown_cost: 0 }],
  stated_dead_stock: null,
  ...over,
});

describe("the screen's words", () => {
  it("states the cash tied up as the headline", () => {
    expect(headline(view())).toBe("€1,040 is tied up in 1 item that isn't selling.");
    expect(headline(view({ slow: [] }))).toBe("Everything you hold is selling.");
    expect(headline(view({ sources: [{ label: "Shopify", as_of: null, items: 0 }] }))).toBe(
      "I haven't read your stock yet.",
    );
  });

  it("prints quiet days as a lower bound when no sale is on record, and cover in words when there's no rate", () => {
    expect(quietText(item())).toBe("120+");
    expect(quietText(item({ days_since_sale: 75, no_sale_for_at_least: null }))).toBe("75");
    expect(coverText(item())).toBe("no sales");
    expect(coverText(item({ days_of_cover: 900 }))).toBe("900");
  });

  it("says plainly when a standing rule blocked an option", () => {
    const o = {
      key: "markdown",
      label: "Mark it down",
      unavailable: null,
      recovered: { low: 0, high: 0, expected: 0 },
      given_up: { low: 0, high: 0, expected: 0 },
      per_euro: null,
      efficiency: "",
      arithmetic: "",
      reversibility: "",
      proposal: { id: "x", status: "blocked", blocked_by_limit: "13.5: We never discount." },
    };
    expect(proposalWord(o)).toEqual({ word: "Blocked by your rule", tone: "alarm" });
  });

  it("shows the owner's dead-stock estimate beside what was measured (rule 11)", () => {
    expect(
      statedVsMeasured(view({ stated_dead_stock: { amount_minor: 50_000, currency: "EUR" } })),
    ).toBe(
      "You estimated your dead stock at €500; I measure €1,040 at cost in stock that isn't selling — €540 more. Your estimate stays on your fact sheet.",
    );
    expect(statedVsMeasured(view())).toBeNull();
  });
});

describe("who sees it — data, not an if on business type", () => {
  const ctx = (fields: Record<string, FieldView>) => ({ get: (k: string) => fields[k] });
  const sells = (...codes: string[]) => ({
    status: "answered" as const,
    value: codes.map((code) => ({ code })),
  });

  it("a business selling physical products sees it; a services-only one never does", () => {
    expect(
      evaluate(STOCK_APPLIES, ctx({ "identity.sells": sells("physical_products", "services") })),
    ).toBe(true);
    expect(evaluate(STOCK_APPLIES, ctx({ "identity.sells": sells("services") }))).toBe(false);
    expect(evaluate(STOCK_APPLIES, ctx({}))).toBe(false);
  });

  it('an owner who said they hold no stock (1.4.1.2 "no") doesn\'t see it', () => {
    expect(
      evaluate(
        STOCK_APPLIES,
        ctx({
          "identity.sells": sells("physical_products"),
          "offers.physical.holds_inventory": { status: "answered", value: { code: "no" } },
        }),
      ),
    ).toBe(false);
  });

  it("the menu shows Slow stock only when the counts say the business holds stock", () => {
    const counts = (stock: boolean) => ({ stock, by_module: {} }) as unknown as NavCounts;
    const hrefs = (c: NavCounts | null) =>
      visibleGroups(null, c).flatMap((g) => g.items.map((i) => i.href));
    expect(hrefs(counts(true))).toContain("/stock");
    expect(hrefs(counts(false))).not.toContain("/stock");
    expect(hrefs(null)).not.toContain("/stock"); // still loading: not shown on a guess
    // Without counts the size table alone decides, as before.
    expect(visibleGroups(null)).toEqual(GROUPS);
  });
});
