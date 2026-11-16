import { describe, expect, it } from "vitest";
import type { PatternsView } from "../../app/api/patterns/route";
import { addDays, seasonForecast } from "../../lib/seasons/forecast";
import {
  aheadRows,
  aheadTitle,
  headline,
  longDate,
  marginText,
  monthBars,
  proposalWord,
  seasonChartModel,
  togetherBars,
} from "./patterns-view";

const INFO = { noun: "revenue", source: "Shopify", currency: "EUR" };
const TODAY = "2026-10-26";

function year(): Map<string, number> {
  const m = new Map<string, number>();
  for (let d = "2025-10-20"; d <= "2026-10-25"; d = addDays(d, 1)) {
    m.set(d, d >= "2025-11-24" && d <= "2025-12-21" ? 20_000 : 10_000);
  }
  return m;
}

function view(seasons: PatternsView["seasons"]["result"]): PatternsView {
  return {
    seasons: { result: seasons, connect: "Connect Shopify", other_currencies: [] },
    bundles: {
      today: TODAY,
      sources: [],
      thresholds: { min_baskets: 50, min_together: 5, min_lift: 1.2, window_days: 365 },
      without_lines: [],
    },
    proposed: {},
    held: null,
  };
}

describe("the season chart model", () => {
  it("marks last year's weeks that line up with the next eight", () => {
    const r = seasonForecast(year(), INFO, TODAY);
    const m = seasonChartModel(r)!;
    expect(m.weeks.filter((w) => w.ahead)).toHaveLength(8);
    expect(m.weeks.find((w) => w.start === "2025-11-24")?.flag).toBe("busy");
    expect(m.lines).toEqual({ busy: 1.25, quiet: 0.8 });
    expect(m.band).toEqual({ low: 1, high: 1 });
  });

  it("with too little history, draws the weeks against their own median and names no season", () => {
    const short = new Map<string, number>();
    for (let d = "2026-06-01"; d <= "2026-10-25"; d = addDays(d, 1)) short.set(d, 10_000);
    const r = seasonForecast(short, INFO, TODAY);
    const m = seasonChartModel(r)!;
    expect(m.lines).toBeNull();
    expect(m.band).toBeNull();
    expect(m.title).toMatch(/not a season/);
    expect(m.weeks.every((w) => w.flag === null)).toBe(true);
  });

  it("has nothing to draw with nothing measured", () => {
    expect(seasonChartModel({ status: "no_data" })).toBeNull();
  });
});

describe("the words", () => {
  it("leads with the season, and the next eight weeks name last year's figure", () => {
    const r = seasonForecast(year(), INFO, TODAY);
    expect(headline(view(r))).toMatch(/busy stretch starts in 4 weeks/);
    if (r.status !== "ready") throw new Error(r.status);
    const rows = aheadRows(r);
    expect(rows[4]).toMatchObject({ week: "Week of 23 Nov", flag: "busy" });
    expect(rows[4]!.figure).toMatch(/2\.0×/);
  });

  it("says a margin is unknown rather than showing zero", () => {
    expect(marginText({ known: false, why: "no cost on record for Vase" })).toBe(
      "Margin unknown: no cost on record for Vase.",
    );
    expect(
      marginText({
        known: true,
        currency: "EUR",
        price_minor: 16_600,
        contribution_minor: 11_700,
        margin_pct: 70.5,
        formula: "",
      }),
    ).toMatch(/70\.5%/);
  });

  it("words a pair's proposal state, and nothing when there is none", () => {
    expect(proposalWord(undefined)).toBeNull();
    expect(proposalWord({ status: "pending" })?.word).toBe("Waiting for you");
    expect(proposalWord({ status: "blocked" })?.tone).toBe("alarm");
  });
});

describe("the next-weeks title", () => {
  it("says this week rather than in 0 weeks", () => {
    const r = seasonForecast(year(), INFO, TODAY);
    if (r.status !== "ready") throw new Error(r.status);
    const u = r.upcoming[0]!;
    expect(aheadTitle(u)).toBe("A busy stretch starts in 4 weeks");
    expect(aheadTitle({ ...u, starts_in_weeks: 0 })).toBe("A busy stretch starts this week");
    expect(aheadTitle({ ...u, in_progress: true })).toBe("A busy stretch is under way");
    expect(longDate("2025-10-04")).toBe("4 Oct 2025");
  });
});

describe("the bars beside the figures", () => {
  it("sets each month against the largest shown, busy and quiet by the season's own lines", () => {
    const m = monthBars([{ index: 2 }, { index: 1.25 }, { index: 1 }, { index: 0.8 }])!;
    expect(m.normal).toBe(0.5);
    expect(m.bars).toEqual([
      { share: 1, tone: "ink" },
      { share: 0.625, tone: "ink" },
      { share: 0.5, tone: "soft" },
      { share: 0.4, tone: "drift" },
    ]);
    // A year with no month above normal still holds the normal line on its scale.
    expect(monthBars([{ index: 0.5 }])).toEqual({
      normal: 1,
      bars: [{ share: 0.5, tone: "drift" }],
    });
  });

  it("draws the months of a measured year", () => {
    const r = seasonForecast(year(), INFO, TODAY);
    if (r.status !== "ready") throw new Error(r.status);
    const m = monthBars(r.months)!;
    expect(m.bars).toHaveLength(r.months.length);
    expect(m.bars.some((b) => b.tone === "ink")).toBe(true);
  });

  it("has no month bars without months, and no pair bars without pairs", () => {
    expect(monthBars([])).toBeNull();
    expect(togetherBars([])).toEqual([]);
  });

  it("sets each pair's count together against the largest in the table", () => {
    expect(togetherBars([{ together: 20 }, { together: 5 }])).toEqual([1, 0.25]);
  });
});
