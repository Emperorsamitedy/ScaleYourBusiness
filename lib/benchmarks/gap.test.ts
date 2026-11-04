// I-44a: what makes a benchmark gap large, pure. Each rule has a passing
// and a failing case: the threshold both sides, the reading, the size and
// code of the cell, the EU aggregate, one currency, an ASSUMED input, the
// severity step, the confidence and the finding's evidence and source.

import { describe, expect, it } from "vitest";
import type { CostLine, CountFact, MoneyFact } from "../cash/model";
import type { BenchInputs } from "./compare";
import { compareWithSimilar } from "./compare";
import { EU_AGGREGATE, LARGE_GAP, gapBasis, gapFinding, largeGap } from "./gap";
import type { BenchCell, Snapshot } from "./snapshot";
import { SNAPSHOT } from "./snapshot";

const money = (major: number, currency = "EUR", basis: MoneyFact["basis"] = "STATED") => ({
  amount_minor: Math.round(major * 100),
  currency,
  basis,
  source: "as you told me",
  on: "2026-10-01",
});
const count = (value: number, basis: CountFact["basis"] = "STATED"): CountFact => ({
  value,
  basis,
  source: "as you told me",
});
const cost = (id: string, category: string, amount: MoneyFact | null): CostLine => ({
  key: `costs.${id}`,
  label: id,
  category,
  list: "fixed",
  amount,
  cadence: "monthly",
});

/** Revenue €20,000, gross margin 70 %, rent €2,000: the margin is 60 % less wages ÷ revenue. */
function inputs(wages: number, over: Partial<BenchInputs> = {}): BenchInputs {
  return {
    as_of: "2026-11-03",
    business_type: { code: "restaurant" },
    country: { raw: "Ireland", iso: "IE" },
    team_size: count(3),
    size_band: null,
    revenue: money(20_000),
    orders_month: null,
    gross_margin: count(70),
    offers: [],
    costs: [cost("rent", "rent", money(2_000)), cost("wages", "salaries", money(wages))],
    staff: null,
    ...over,
  };
}

function snap(cells: BenchCell[]): Snapshot {
  return {
    ...SNAPSHOT,
    geos: { IE: "Ireland", [EU_AGGREGATE]: "European Union" },
    nace: {
      I56: "Food and beverage service activities",
      I: "Accommodation and food service activities",
    },
    cells,
  };
}

const sectorAt = (gor: number, nace = "I56", geo = "IE", size = "TOTAL"): BenchCell => ({
  geo,
  nace,
  size,
  values: { GOR_PC: { value: gor, year: 2024 } },
});

const run = (x: BenchInputs, s: Snapshot) => largeGap(compareWithSimilar(x, s), x);

describe("a large margin gap (I-44a)", () => {
  // wages €8,000 → margin 20 %; €10,000 → 10 %; €12,000 → 0 %.
  it("is large at the threshold, 10 points under", () => {
    const g = run(inputs(8_000), snap([sectorAt(30)]));
    expect(g?.points).toBe(LARGE_GAP.margin_points);
    expect(g?.own_pct).toBe(20);
    expect(g?.bench_pct).toBe(30);
    expect(g?.severity).toBe("medium");
  });

  it("is not large just under the threshold", () => {
    expect(run(inputs(8_000), snap([sectorAt(29.9)]))).toBeNull();
  });

  it("is never large above or about the same as the sector", () => {
    expect(run(inputs(2_000), snap([sectorAt(30)]))).toBeNull(); // 50 % against 30 %
    expect(run(inputs(8_000), snap([sectorAt(22)]))).toBeNull(); // 20 % against 22 %
  });

  it("reads HIGH from 20 points under", () => {
    expect(run(inputs(12_000), snap([sectorAt(20)]))?.severity).toBe("high"); // 0 % vs 20 %
    expect(run(inputs(12_000), snap([sectorAt(19.9)]))?.severity).toBe("medium");
  });

  it("takes the every-size cell the screen falls back to, and keeps its note", () => {
    const micro: BenchCell = {
      geo: "IE",
      nace: "I56",
      size: "0-9",
      values: { NETTUR_EMP_TEUR: { value: 50, year: 2024 } },
    };
    const g = run(inputs(12_000), snap([sectorAt(30), micro]));
    // The 0-9 cell publishes no margin, so the every-size cell is used, with its note.
    expect(g?.cell.size).toBe("TOTAL");
    expect(g?.cell.fallback).toMatch(/every size|biggest firms/);
    expect(gapBasis(g!)).toContain(g!.cell.fallback!.trim());
  });

  it("refuses a cell from the parent code, which isn't like for like", () => {
    expect(run(inputs(12_000), snap([sectorAt(30, "I")]))).toBeNull();
    // The same figure at the type's own code is a gap.
    expect(run(inputs(12_000), snap([sectorAt(30, "I56")]))).not.toBeNull();
  });

  it("never compares against the EU27 aggregate", () => {
    expect(run(inputs(12_000), snap([sectorAt(30, "I56", EU_AGGREGATE)]))).toBeNull();
  });

  it("refuses a margin with a cost in another currency", () => {
    const x = inputs(12_000, {
      costs: [
        cost("rent", "rent", money(2_000)),
        cost("wages", "salaries", money(12_000)),
        cost("software", "software", money(50, "USD")),
      ],
    });
    expect(run(x, snap([sectorAt(30)]))).toBeNull();
    expect(run(inputs(12_000), snap([sectorAt(30)]))).not.toBeNull();
  });

  it("refuses a margin resting on an ASSUMED input", () => {
    const x = inputs(12_000, { revenue: money(20_000, "EUR", "ASSUMED") });
    expect(run(x, snap([sectorAt(30)]))).toBeNull();
  });

  it("refuses when the margin isn't compared at all", () => {
    expect(run(inputs(12_000, { revenue: null }), snap([sectorAt(30)]))).toBeNull();
    expect(run(inputs(12_000), snap([]))).toBeNull();
  });

  it("takes the weakest input's confidence", () => {
    // Running costs are DERIVED (made monthly from the costs list): 0.6.
    expect(run(inputs(12_000), snap([sectorAt(30)]))?.confidence).toBe(0.6);
    const est = inputs(12_000, { revenue: money(20_000, "EUR", "ESTIMATED") });
    expect(run(est, snap([sectorAt(30)]))?.confidence).toBe(0.5);
  });
});

describe("the gap as a report finding", () => {
  const g = run(inputs(12_000), snap([sectorAt(30)]))!;

  it("is a benchmark finding citing the snapshot's own keys", () => {
    const keys = new Set(["revenue.monthly_revenue", "costs.gross_margin", "costs.rent.amount"]);
    const f = gapFinding(g, keys);
    expect(f?.kind).toBe("benchmark");
    expect(f?.area).toBe("finance");
    expect(f?.severity).toBe("high");
    expect(f?.evidence.every((k) => keys.has(k))).toBe(true);
    expect(f?.evidence).toContain("revenue.monthly_revenue");
    expect(f?.title).toMatch(/30\.0 points below Eurostat's figure/);
  });

  it("cites Eurostat, the snapshot's dates, the cell and its basis", () => {
    const f = gapFinding(g, new Set(["revenue.monthly_revenue"]))!;
    expect(f.detail).toContain(`Eurostat, ${SNAPSHOT.source.dataset}, updated`);
    expect(f.detail).toContain(g.cell.words);
    expect(f.detail).toContain(g.formula);
    expect(f.detail).toContain(g.gap_note);
    expect(f.detail).toMatch(/not a typical business/);
  });

  it("is no finding without the revenue in the snapshot (P1-24)", () => {
    expect(gapFinding(g, new Set(["costs.gross_margin"]))).toBeNull();
  });
});
