import { describe, expect, it } from "vitest";
import type { PatternsView } from "../../app/api/patterns/route";
import { addDays, seasonForecast } from "../../lib/seasons/forecast";
import {
  aheadRows,
  currentRun,
  headline,
  longDate,
  monthTone,
  pairMoney,
  proposalWord,
  seasonChartModel,
  signedPct,
  sizePct,
  titleOf,
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
  it("leads with the season, and the next eight weeks give last year's figure as a percentage", () => {
    const r = seasonForecast(year(), INFO, TODAY);
    expect(headline(view(r))).toMatch(/busy stretch starts in 4 weeks/);
    if (r.status !== "ready") throw new Error(r.status);
    const rows = aheadRows(r);
    expect(rows[4]).toMatchObject({ start: "2026-11-23", flag: "busy", pct: "+100%" });
    expect(rows[4]!.value).toBe("€1,400");
  });

  it("says a percentage from normal with its sign, and its size without", () => {
    expect(signedPct(1.91)).toBe("+91%");
    expect(signedPct(0.72)).toBe("-28%");
    expect(signedPct(1.004)).toBe("0%");
    expect(signedPct(0.996)).toBe("0%");
    expect(sizePct(0.72)).toBe("28%");
  });

  it("says a margin is unknown rather than showing zero", () => {
    expect(pairMoney({ known: false, why: "no cost on record for Vase" })).toEqual({
      known: false,
      why: "Margin unknown: no cost on record for Vase.",
    });
    expect(
      pairMoney({
        known: true,
        currency: "EUR",
        price_minor: 16_600,
        contribution_minor: 11_700,
        margin_pct: 70.5,
        formula: "",
      }),
    ).toMatchObject({ known: true, price: "€166", left: "€117", pct: "71%" });
  });

  it("words a pair's proposal state, and nothing when there is none", () => {
    expect(proposalWord(undefined)).toBeNull();
    expect(proposalWord({ status: "pending" })?.word).toBe("Waiting for you");
    expect(proposalWord({ status: "blocked" })?.tone).toBe("alarm");
  });
});

describe("the title", () => {
  it("names the first stretch ahead: under way, this week, or in so many weeks", () => {
    const r = seasonForecast(year(), INFO, TODAY);
    if (r.status !== "ready") throw new Error(r.status);
    const u = r.upcoming[0]!;
    expect(titleOf(r)).toEqual({ key: "title.startsIn", kind: "busy", count: 4 });
    expect(titleOf({ ...r, upcoming: [{ ...u, starts_in_weeks: 0 }] })).toEqual({
      key: "title.thisWeek",
      kind: "busy",
    });
    expect(titleOf({ ...r, upcoming: [{ ...u, in_progress: true }] })).toEqual({
      key: "title.underWay",
      kind: "busy",
    });
    expect(titleOf({ ...r, upcoming: [] })).toEqual({ key: "title.even", count: 8 });
    expect(longDate("2025-10-04")).toBe("4 Oct 2025");
  });
});

describe("this year's stretch and the month strip", () => {
  it("counts back the latest weeks that share a flag, and names no single week", () => {
    const w = (start: string, flag: "busy" | "quiet" | null) => ({ start, flag });
    expect(
      currentRun([w("2026-10-19", null), w("2026-10-26", "busy"), w("2026-11-02", "busy")]),
    ).toEqual({ kind: "busy", start: "2026-10-26", weeks: 2 });
    expect(currentRun([w("2026-10-26", null), w("2026-11-02", "quiet")])).toBeNull();
    expect(currentRun([w("2026-11-02", null)])).toBeNull();
    expect(currentRun([])).toBeNull();
  });

  it("shades a month busy or quiet by the season's own lines, and nudges between", () => {
    expect([1.61, 1.25, 1.12, 1, 0.94, 0.88, 0.8, 0.73].map(monthTone)).toEqual([
      "busy",
      "busy",
      "up",
      "even",
      "even",
      "down",
      "quiet",
      "quiet",
    ]);
  });
});
