// Feature 36 — the simulator screen's words and geometry. A gap reads as a
// worded flag, never a number; the picker holds the side by side to four;
// the first picks are priced options of different kinds; the headline
// counts real options; the whiskers share one axis that includes zero.

import { describe, expect, it } from "vitest";
import type { AdsChartModel } from "../../lib/charts/small";
import { bare, full } from "../../lib/simulate/fixtures";
import type { SimOption } from "../../lib/simulate/model";
import { SIM, compareOptions, simulateOption } from "../../lib/simulate/model";
import {
  adsDays,
  allOptions,
  cellView,
  defaultPicks,
  headline,
  shareSteps,
  togglePick,
  whiskerChart,
} from "./view";
import { catalogOf } from "../../lib/simulate/model";

const EMAIL: SimOption = { kind: "email", segment: "lapsed" };
const RAISE: SimOption = { kind: "ads", change: "raise", campaign_ref: "120000001", share: 0.2 };
const CONTENT: SimOption = { kind: "content" };

describe("a cell in words", () => {
  it("a range prints low – high with the basis of what it rests on", () => {
    const r = simulateOption(EMAIL, full());
    expect(cellView(r.measures.revenue, "money", "EUR")).toMatchObject({
      figure: "€400 – €1,020",
      basis: "OBSERVED",
      flag: null,
    });
    // A cost the option sets is one figure, not a forecast.
    expect(cellView(r.measures.cost, "money", "EUR")).toMatchObject({
      figure: "€0",
      basis: "SET BY THE OPTION",
    });
  });

  it("a missing input reads MISSING with what fills it — never a number", () => {
    const r = simulateOption(EMAIL, bare());
    const v = cellView(r.measures.revenue, "money", "EUR");
    expect(v.figure).toBe("—");
    expect(v.flag).toBe("MISSING");
    expect(v.detail).toMatch(/^needs /);
    expect(v.figure).not.toMatch(/\d/);
    expect(cellView(simulateOption(RAISE, full()).measures.orders, "count", "EUR").flag).toBe(
      "NOT READ",
    );
  });
});

describe("the picker", () => {
  it("offers 5%–50% in 5% steps", () => {
    expect(shareSteps()).toEqual([0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5]);
  });

  it("holds the side by side to four, and a second press removes", () => {
    let picks: SimOption[] = [];
    for (const o of allOptions(catalogOf(full()))) picks = togglePick(picks, o);
    expect(picks).toHaveLength(SIM.max_options);
    expect(togglePick(picks, picks[0]!)).toHaveLength(SIM.max_options - 1);
  });

  it("starts on two priced options of different kinds", () => {
    const picks = defaultPicks(catalogOf(full()), full());
    expect(picks).toHaveLength(2);
    expect(new Set(picks.map((p) => p.kind)).size).toBe(2);
    // Nothing priced: still two options, so the gaps show side by side.
    expect(defaultPicks(catalogOf(bare()), bare())).toHaveLength(2);
  });

  it("the headline counts what can really be priced", () => {
    expect(headline(catalogOf(full()), full())).toMatch(
      /^\d+ of your 9 campaign options can be priced/,
    );
    expect(headline(catalogOf(bare()), bare())).toBe(
      "None of your 3 campaign options can be priced from your own numbers yet — each one shows what it's missing.",
    );
  });
});

describe("the whiskers", () => {
  it("share one axis that includes zero, low left of high, worst inside the axis", () => {
    const cmp = compareOptions([EMAIL, RAISE, CONTENT], full());
    const chart = whiskerChart(cmp.options)!;
    expect(chart.zero).toBeGreaterThanOrEqual(0);
    expect(chart.zero).toBeLessThanOrEqual(100);
    for (const r of chart.rows) {
      if (r.low === null || r.high === null) continue;
      expect(r.low).toBeLessThanOrEqual(r.high);
      expect(r.low).toBeGreaterThanOrEqual(0);
      expect(r.high).toBeLessThanOrEqual(100);
    }
    expect(chart.ticks[0]!.at).toBe(0);
    expect(chart.ticks.at(-1)!.at).toBeCloseTo(100);
  });

  it("a profit that wasn't worked out has no whisker; two currencies have no shared axis", () => {
    const x = full();
    x.margin = { computed_pct: null, computed_formula: null, stated_pct: null, stated_basis: null };
    const chart = whiskerChart(compareOptions([EMAIL, RAISE], x).options)!;
    expect(chart.rows.every((r) => r.low === null && r.text === "not worked out")).toBe(true);
    expect(
      whiskerChart(
        compareOptions(
          [EMAIL, { kind: "ads", change: "new", daily_budget_minor: 500_000, currency: "HUF" }],
          full(),
        ).options,
      ),
    ).toBeNull();
  });
});

describe("the ads chart beside the options", () => {
  const ads: AdsChartModel = {
    window: { from: "2026-10-12", to: "2026-10-25", days: 14 },
    campaigns: [
      {
        campaign_ref: "120000001",
        campaign_name: "Autumn glazes",
        currency: "EUR",
        measured_days: 14,
        spend_minor: 42_000,
        value_minor: 30_000,
        roas: 30_000 / 42_000,
        losing: true,
      },
      {
        platform: "google",
        campaign_ref: "77",
        campaign_name: "Search · mugs",
        currency: "EUR",
        measured_days: 5,
        spend_minor: 9_000,
        value_minor: 21_000,
        roas: 21_000 / 9_000,
        losing: false,
      },
    ],
    platforms: ["meta", "google"],
    losing: 1,
    summary: "",
  };

  it("lists each campaign's measured days of the chart's window", () => {
    expect(adsDays(ads)).toEqual([
      { key: "meta:120000001", name: "Autumn glazes", days: 14, window: 14 },
      { key: "google:77", name: "Search · mugs", days: 5, window: 14 },
    ]);
  });

  it("lists nothing without ads data", () => {
    expect(adsDays(null)).toEqual([]);
    expect(adsDays(undefined)).toEqual([]);
    expect(adsDays({ ...ads, campaigns: [] })).toEqual([]);
  });
});
