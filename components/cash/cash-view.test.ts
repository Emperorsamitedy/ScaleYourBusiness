// P5-10 — the /cash screen's words and chart model, pure. The planning-aid
// note and the sources line exist in every state; the chart draws today and
// 13 week-ends with the band, the line and the tight week; the tables carry
// every figure the chart draws.

import { describe, expect, it } from "vitest";
import type { CashView } from "../../app/api/cash/route";
import { TODAY, baseInputs, cost, daily } from "../../lib/cash/fixtures";
import type { CashReady } from "../../lib/cash/model";
import { forecastCash } from "../../lib/cash/model";
import { compareScenarios, defaultChoice } from "../../lib/cash/scenarios";
import { tightWeek } from "../../lib/cash/warnings";
import {
  PLANNING_NOTE,
  cashChartModel,
  cashTiles,
  headLede,
  headTitle,
  headline,
  rangeText,
  scenarioColumns,
  sourcesLine,
  weekRows,
} from "./cash-view";

const tightInputs = baseInputs({
  revenue: daily(TODAY, 120, () => 10_000),
  costs: [cost("Rent", 1200, "monthly"), cost("VAT return", 9000, "quarterly")],
});

function viewOf(f: ReturnType<typeof forecastCash>): CashView {
  if (f.status !== "ready")
    return { forecast: f, outside: null, tight: null, scenarios: null, choice: null, price: null };
  return {
    forecast: f,
    outside: null,
    tight: tightWeek(f),
    scenarios: compareScenarios(tightInputs, f, defaultChoice(tightInputs, f), null),
    choice: defaultChoice(tightInputs, f),
    price: null,
  };
}

const ready = forecastCash(tightInputs) as CashReady;

describe("P5-10 — always on the screen", () => {
  it("the note says planning aid, not financial advice, and that nothing moves money", () => {
    expect(PLANNING_NOTE).toMatch(/planning aid/i);
    expect(PLANNING_NOTE).toMatch(/not financial advice/);
    expect(PLANNING_NOTE).toMatch(/never moves, pays or collects money/);
  });

  it("a sources line in every state: ready, too little, nothing measured", () => {
    expect(sourcesLine(ready)).toMatch(
      /^Sources: cash today €5,000 \(STATED\) · money in Shopify revenue/,
    );
    const little = forecastCash(baseInputs({ revenue: daily(TODAY, 30, () => 1) }));
    expect(sourcesLine(little)).toMatch(
      /^Sources: Shopify revenue, 30 measured days .* 4 of 8 complete weeks needed\.$/,
    );
    expect(sourcesLine(forecastCash(baseInputs({ revenue: null })))).toMatch(
      /^Sources: nothing measured/,
    );
  });

  it("history to spare, cash unknown: '8 of 8' weeks, never '13 of 8'", () => {
    const noCash = forecastCash(
      baseInputs({ cash: { status: "unknown" }, revenue: daily(TODAY, 120, () => 100) }),
    );
    expect(noCash.status).not.toBe("ready");
    expect(sourcesLine(noCash)).toMatch(/ 8 of 8 complete weeks needed\.$/);
  });
});

describe("P5-10 — the head states the main fact", () => {
  it("the tight week when there is one, else that there isn't, else the refusal", () => {
    expect(headline(viewOf(ready))).toBe(
      "Money could get tight in the week of 29 Dec: the cautious end is −€600.",
    );
    expect(headline(viewOf(forecastCash(baseInputs())))).toBe(
      "No week of the next 13 dips under your €2,000 buffer, even at the cautious end.",
    );
    const refused = forecastCash(baseInputs({ revenue: daily(TODAY, 30, () => 1) }));
    expect(headline(viewOf(refused))).toMatch(/a 13-week cash forecast needs 8/);
  });

  it("on the screen: a short title, and the figures in one line under it", () => {
    const tight = viewOf(ready);
    expect(headTitle(tight)).toBe("Money could get tight in the week of 29 Dec.");
    expect(headLede(tight)).toBe(
      "At the cautious end the balance is about −€600, under the €2,000 you want to keep.",
    );
    const clear = viewOf(forecastCash(baseInputs()));
    expect(headTitle(clear)).toBe(headline(clear));
    expect(headLede(clear)).toMatch(/stays above the line every week/);
    const refused = viewOf(forecastCash(baseInputs({ revenue: daily(TODAY, 30, () => 1) })));
    expect(headTitle(refused)).toBe(headline(refused));
    expect(headLede(refused)).toBeNull();
  });

  it("three figures over the chart: today, the lowest point and its week, where the 13 weeks end", () => {
    const tiles = cashTiles(ready);
    expect(tiles.today).toMatchObject({ value: "€5,000", basis: "STATED" });
    expect(tiles.lowest).toMatchObject({ value: "−€600", week: "Week of 29 Dec", under: true });
    // This fixture's weeks all run alike, so both ends round to one figure.
    expect(tiles.end.value).toBe(rangeText(ready.end, "EUR"));
    expect(tiles.end.value).toBe("€1,500");
    expect(cashTiles(forecastCash(baseInputs()) as CashReady).lowest.under).toBe(false);
  });
});

describe("P5-10 — the chart model and the tables", () => {
  it("today plus 13 week-ends, the line, and the tight week offset by today's point", () => {
    const m = cashChartModel(ready, 9);
    expect(m.points).toHaveLength(14);
    expect(m.points[0]).toMatchObject({ label: "Today", low: 500_000, high: 500_000 });
    expect(m.line).toEqual({ amount: 200_000, label: "BUFFER" });
    expect(m.tight).toBe(10);
    expect(m.title).toBe("Under your €2,000 buffer in the week of 29 Dec");
    expect(m.meta).toMatch(/OBSERVED .* STATED .* ASSUMED/);
  });

  it("every week in the table, the tight one flagged", () => {
    const rows = weekRows(ready);
    expect(rows).toHaveLength(13);
    expect(rows.filter((r) => r.under).map((r) => r.week)).toContain("Week of 29 Dec");
    expect(rows[9]?.due).toBe("Rent €1,200 · VAT return €9,000");
  });

  it("the plain forecast first, then the scenarios; a missing one says what fills it", () => {
    const v = viewOf(ready);
    const cols = scenarioColumns(ready, v.tight?.index ?? null, v.scenarios ?? []);
    expect(cols.map((c) => c.key)).toEqual(["plain", "slow_month", "big_order", "hire", "price"]);
    expect(cols[0]?.tight).toBe("week of 29 Dec");
    expect(cols.find((c) => c.key === "hire")).toMatchObject({ status: "missing" });
  });

  it("a range prints both ends, a point once", () => {
    expect(rangeText({ low: 310_000, high: 540_000 }, "EUR")).toBe("€3,100 to €5,400");
    expect(rangeText({ low: 310_000, high: 310_049 }, "EUR")).toBe("€3,100");
  });
});
