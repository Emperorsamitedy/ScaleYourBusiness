// I-54.2 — forecasts become claims exactly as they were shown. Pure.

import { describe, expect, it } from "vitest";
import type { CoverAssessment } from "../stock/cover";
import type { CoverRow, CoverView } from "../stock/cover-load";
import type { SeasonResult } from "../seasons/forecast";
import type { SeasonsView } from "../seasons/load";
import { seasonClaims, stockClaims } from "./claims";

const owner = { account_id: "a", profile_id: "p" };
const NOW = new Date("2026-10-28T09:00:00.000Z"); // a Wednesday, ISO week 44

function warned(over: Partial<CoverAssessment> = {}, onHand = 9): CoverRow {
  return {
    key: "conn:mug",
    name: "Speckled Everyday Mug",
    source: "Shopify",
    item: { connection_id: "conn", ref: "mug", on_hand: onHand, as_of: "2026-10-28" },
    cover: {
      status: "ready",
      cover: { low: 3.6, mid: 4.4, high: 5.6 },
      warning: {
        level: "before_restock",
        flag: "ACT NOW",
        sentence:
          "Speckled Everyday Mug runs out in about 4–6 days; Midland Clay Supplies takes 10 days.",
      },
      sources:
        "31 sold 2026-09-28 to 2026-10-27, measured by Shopify; 9 on hand, read on 2026-10-28",
      assumed: ["the coming days sell at the pace of the last 30 days (31 sold)"],
      ...over,
    },
  } as unknown as CoverRow;
}

const cover = (rows: CoverRow[]) =>
  ({ today: "2026-10-28", warnings: rows }) as unknown as CoverView;

describe("stock-out warnings", () => {
  it("records the warning's own whole days as dates, once per item a week", () => {
    const [c] = stockClaims(owner, cover([warned()]), NOW);
    expect(c).toMatchObject({
      kind: "stock_out",
      forecast_key: "stock_out|conn:mug|2026-W44",
      unit: "date",
      window_start: "2026-10-28",
      low_date: "2026-11-01",
      high_date: "2026-11-03",
      window_end: "2026-11-03",
      subject_ref: { connection_id: "conn", product_ref: "mug", on_hand: 9, as_of: "2026-10-28" },
    });
    expect(c!.claim).toContain("runs out in about 4–6 days");
    expect(c!.claim).toContain("between 1 Nov 2026 and 3 Nov 2026");
    expect(c!.basis).toMatch(/measured by Shopify.*Assumed: the coming days/);
  });

  it("records nothing for a warning with no upper end: no day could prove it wrong", () => {
    const open = warned({ cover: { low: 3.6, mid: 9, high: null } });
    expect(stockClaims(owner, cover([open]), NOW)).toEqual([]);
  });

  it("records nothing for an item already sold out", () => {
    expect(stockClaims(owner, cover([warned({}, 0)]), NOW)).toEqual([]);
  });
});

function seasons(over: Partial<Extract<SeasonResult, { status: "ready" }>> = {}): SeasonsView {
  const week = (start: string, ly: { index: number; low: number; high: number | null } | null) => ({
    start,
    last_year_start: start.replace("2026", "2025"),
    last_year: ly ? { ...ly, value: 400_000 } : null,
    flag: null,
  });
  return {
    connect: "",
    other_currencies: [],
    series_ref: { connection_id: "conn", metric: "revenue.daily" },
    result: {
      status: "ready",
      series: { noun: "revenue", source: "Shopify", currency: "EUR" },
      today: "2026-10-28",
      normal: {
        median: 200_000,
        p25: 180_000,
        p75: 230_000,
        weeks: 52,
        from: "2025-10-27",
        to: "2026-10-25",
      },
      ahead: [
        week("2026-10-26", { index: 1, low: 0.9, high: 1.1 }),
        week("2026-11-02", { index: 2.1, low: 1.85, high: 2.333 }),
        week("2026-11-09", null),
        week("2026-11-16", { index: 2, low: 1.8, high: null }),
      ],
      ...over,
    } as unknown as SeasonResult,
  };
}

describe("the season's next weeks", () => {
  it("records a week ahead in money, rounded outward, keyed by the week alone", () => {
    const claims = seasonClaims(owner, seasons(), NOW);
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      kind: "season_week",
      forecast_key: "season_week|conn|revenue.daily|EUR|2026-11-02",
      unit: "money",
      currency: "EUR",
      window_start: "2026-11-02",
      window_end: "2026-11-08",
      low_minor: 370_000,
      high_minor: 466_600,
    });
    expect(claims[0]!.claim).toBe(
      "The week of 2 Nov to 8 Nov: €3,700 to €4,666 of revenue, if it runs as the same week did last year.",
    );
    expect(claims[0]!.basis).toMatch(/your normal week is €2,000 .*measured by Shopify/);
  });

  it("leaves out the week under way, an unmeasured last year and an open range", () => {
    const keys = seasonClaims(owner, seasons(), NOW).map((c) => c.window_start);
    expect(keys).not.toContain("2026-10-26");
    expect(keys).not.toContain("2026-11-09");
    expect(keys).not.toContain("2026-11-16");
  });

  it("records a count series as a count", () => {
    const view = seasons();
    const r = view.result as Extract<SeasonResult, { status: "ready" }>;
    r.series = { noun: "orders", source: "Shopify", currency: null };
    r.normal = { ...r.normal, median: 40 };
    const [c] = seasonClaims(owner, view, NOW);
    expect(c).toMatchObject({ unit: "count", low_num: "74.0", high_num: "93.4" });
    expect(c!.currency).toBeUndefined();
  });

  it("records nothing when the season isn't read yet", () => {
    expect(seasonClaims(owner, { ...seasons(), result: { status: "no_data" } }, NOW)).toEqual([]);
    expect(seasonClaims(owner, { ...seasons(), series_ref: null }, NOW)).toEqual([]);
  });
});
