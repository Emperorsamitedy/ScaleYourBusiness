// Feature 34 — finding slow stock, deterministically. The two pinned
// thresholds are tested on both sides of the line, from store figures and
// from an imported file, and the ranking is by cash tied up, never across
// currencies.

import { describe, expect, it } from "vitest";
import type { FileSales, RankedItem, StockItem } from "./assess";
import { STOCK, assessItem, rankSlow, shiftDay } from "./assess";

const TODAY = "2026-10-22";
const YESTERDAY = shiftDay(TODAY, -1);

function item(over: Partial<StockItem> = {}): StockItem {
  return {
    provider: "shopify",
    connection_id: "c1",
    ref: "gid://shopify/Product/1",
    name: "Mug",
    as_of: TODAY,
    on_hand: 40,
    value_at_cost: 40 * 980,
    value_at_price: 40 * 3400,
    currency: "EUR",
    cost_basis: "measured",
    offer_id: null,
    sales: { kind: "series", covered_days: 365, daily: new Map() },
    ...over,
  };
}

/** A store item whose only sale was `daysAgo` days before today. */
const lastSoldAgo = (daysAgo: number, covered = 365, units = 1) =>
  item({
    sales: {
      kind: "series",
      covered_days: covered,
      daily: new Map([[shiftDay(TODAY, -daysAgo), units]]),
    },
  });

/** Store sales of `perDay` units every day of the history. */
const steady = (perDay: number, covered = 365) =>
  item({
    sales: {
      kind: "series",
      covered_days: covered,
      daily: new Map(
        Array.from({ length: covered }, (_, i) => [shiftDay(YESTERDAY, -i), perDay] as const),
      ),
    },
  });

const file = (sales: Partial<FileSales>, over: Partial<StockItem> = {}) =>
  item({
    provider: "stock_import",
    sales: {
      kind: "file",
      window_days: null,
      units_in_window: null,
      days_since_sale: null,
      ...sales,
    },
    ...over,
  });

describe("STUCK — no sale in the last 60 days, with stock on hand", () => {
  it("a last sale 61 days ago is stuck; 60 days ago is not", () => {
    expect(STOCK.stuck_no_sale_days).toBe(60);
    expect(assessItem(lastSoldAgo(61), TODAY).flag).toBe("STUCK");
    expect(assessItem(lastSoldAgo(60), TODAY).flag).not.toBe("STUCK");
  });

  it("no sale at all in 60 measured days is stuck; in 59 it is only slow", () => {
    const quiet = (covered: number) =>
      item({ sales: { kind: "series", covered_days: covered, daily: new Map() } });
    expect(assessItem(quiet(60), TODAY)).toMatchObject({
      flag: "STUCK",
      no_sale_for_at_least: 60,
    });
    // 59 measured days with no sale: slow (no rate), not stuck — the history doesn't cover the line.
    expect(assessItem(quiet(59), TODAY).flag).toBe("SLOW");
  });

  it("nothing on hand is never flagged, however quiet", () => {
    expect(assessItem({ ...lastSoldAgo(200), on_hand: 0 }, TODAY).flag).toBeNull();
  });

  it("from a file: a last-sold date more than 60 days before the count is stuck; 60 is not", () => {
    expect(assessItem(file({ days_since_sale: 61 }), TODAY).flag).toBe("STUCK");
    expect(assessItem(file({ days_since_sale: 60 }), TODAY).flag).toBeNull();
  });

  it("from a file: zero sold over a 60-day window is stuck; over 59 days it is only slow", () => {
    expect(assessItem(file({ window_days: 60, units_in_window: 0 }), TODAY).flag).toBe("STUCK");
    expect(assessItem(file({ window_days: 59, units_in_window: 0 }), TODAY).flag).toBe("SLOW");
  });
});

describe("SLOW — more than 180 days of cover at the item's own rate", () => {
  it("181 days of cover is slow; exactly 180 is not", () => {
    expect(STOCK.slow_cover_days).toBe(180);
    // 90 sold in 90 days = 1 a day.
    expect(assessItem({ ...steady(1), on_hand: 181 }, TODAY)).toMatchObject({
      flag: "SLOW",
      days_of_cover: 181,
    });
    expect(assessItem({ ...steady(1), on_hand: 180 }, TODAY).flag).toBeNull();
  });

  it("the rate is read over the last 90 days, ending yesterday — today never counts", () => {
    const s = steady(1);
    (s.sales as unknown as { daily: Map<string, number> }).daily.set(TODAY, 1_000);
    const a = assessItem(s, TODAY);
    expect(a.rate).toEqual({ per_day: 1, over_days: 90 });
    expect(a.sold).toEqual({ 30: 30, 60: 60, 90: 90 });
  });

  it("from a file: 181 days of cover over the file's window is slow; 180 is not", () => {
    const f = (onHand: number) =>
      file({ window_days: 90, units_in_window: 45 }, { on_hand: onHand }); // half a unit a day
    expect(assessItem(f(91), TODAY).flag).toBe("SLOW"); // 182 days
    expect(assessItem(f(90), TODAY).flag).toBeNull(); // 180 days
  });

  it("too little history is not judged: 29 measured days proposes nothing, 30 does", () => {
    const quiet = (covered: number) =>
      item({ sales: { kind: "series", covered_days: covered, daily: new Map() } });
    expect(assessItem(quiet(29), TODAY)).toMatchObject({ flag: null });
    expect(assessItem(quiet(29), TODAY).why).toMatch(/only 29 days/);
    expect(assessItem(quiet(30), TODAY).flag).toBe("SLOW");
  });

  it("sold windows the history doesn't cover are null, never zero", () => {
    const a = assessItem(steady(2, 45), TODAY);
    expect(a.sold).toEqual({ 30: 60, 60: null, 90: null });
    expect(a.rate).toEqual({ per_day: 2, over_days: 45 });
  });
});

describe("cash tied up — on hand × unit cost", () => {
  it("is the value at cost, and unknown stays unknown", () => {
    expect(assessItem(lastSoldAgo(90), TODAY).cash_tied_minor).toBe(39_200);
    expect(assessItem({ ...lastSoldAgo(90), value_at_cost: null }, TODAY).cash_tied_minor).toBe(
      null,
    );
  });
});

describe("the ranking — most cash tied up first", () => {
  const ranked = (it: StockItem): RankedItem => ({ item: it, assessment: assessItem(it, TODAY) });

  it("orders flagged items by cash tied up, leaves selling items out, unknown cost last", () => {
    const small = ranked({ ...lastSoldAgo(90), ref: "a", name: "Small", value_at_cost: 1_000 });
    const big = ranked({ ...lastSoldAgo(90), ref: "b", name: "Big", value_at_cost: 90_000 });
    const unknown = ranked({ ...lastSoldAgo(90), ref: "c", name: "Unknown", value_at_cost: null });
    const selling = ranked({ ...steady(5), ref: "d", name: "Selling", value_at_cost: 999_999 });
    expect(rankSlow([small, unknown, selling, big]).map((r) => r.item.name)).toEqual([
      "Big",
      "Small",
      "Unknown",
    ]);
  });

  it("never compares across currencies: the currency most slow items hold comes first", () => {
    const huf = ranked({
      ...lastSoldAgo(90),
      ref: "h",
      name: "HUF item",
      currency: "HUF",
      value_at_cost: 50_000_000,
    });
    const eur1 = ranked({ ...lastSoldAgo(90), ref: "e1", name: "EUR 1", value_at_cost: 100 });
    const eur2 = ranked({ ...lastSoldAgo(90), ref: "e2", name: "EUR 2", value_at_cost: 200 });
    expect(rankSlow([huf, eur1, eur2]).map((r) => r.item.name)).toEqual([
      "EUR 2",
      "EUR 1",
      "HUF item",
    ]);
  });
});
