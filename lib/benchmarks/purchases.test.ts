// I-44b: the purchases share beside the margin, pure. Like for like only:
// the business's own country and code, the size class or the every-size
// cell with its note, never the parent code and never the EU27 aggregate.
// The business's side from the margin's own inputs, in one currency, each
// with its basis; without them, the sector's figure and what it needs.

import { describe, expect, it } from "vitest";
import type { CountFact, MoneyFact, OfferLine } from "../cash/model";
import { trFor } from "../i18n/server-tr";
import type { BenchInputs, BenchLine, ComparedLine } from "./compare";
import { BENCH_ASK, EVERY_SIZE_NOTE, compareWithSimilar } from "./compare";
import { largeGap } from "./gap";
import { PURCHASES_KEY, ownPurchasesShare } from "./purchases";
import type { BenchCell, Snapshot } from "./snapshot";
import { SNAPSHOT } from "./snapshot";

const money = (major: number, currency = "EUR"): MoneyFact => ({
  amount_minor: Math.round(major * 100),
  currency,
  basis: "STATED",
  source: "as you told me",
  on: "2026-10-01",
});
const count = (value: number, basis: CountFact["basis"] = "STATED"): CountFact => ({
  value,
  basis,
  source: "as you told me",
});
const offer = (
  id: string,
  price: MoneyFact,
  cost: MoneyFact | null,
  volume: number,
): OfferLine => ({
  key: `offers.${id}`,
  name: id,
  price,
  cost,
  volume_month: count(volume),
});

function snap(cells: BenchCell[]): Snapshot {
  return {
    ...SNAPSHOT,
    geos: { HU: "Hungary", IE: "Ireland", EU27_2020: "the EU" },
    nace: {
      I56: "Food and beverage service activities",
      I: "Accommodation and food service activities",
    },
    cells,
  };
}

function inputs(over: Partial<BenchInputs> = {}): BenchInputs {
  return {
    as_of: "2026-11-04",
    business_type: { code: "restaurant" },
    country: { raw: "Ireland", iso: "IE" },
    team_size: count(3),
    size_band: null,
    revenue: money(20_000),
    orders_month: null,
    gross_margin: count(70),
    offers: [],
    costs: [],
    staff: null,
    ...over,
  };
}

const PUR = (geo: string, nace: string, size: string, value: number): BenchCell => ({
  geo,
  nace,
  size,
  values: { PUR_SHARE_PC: { value, year: 2024, derived_from: ["PUR_MEUR", "NETTUR_MEUR"] } },
});

/** The purchases line of a comparison. */
function line(x: BenchInputs, s: Snapshot): BenchLine {
  const r = compareWithSimilar(x, s);
  if (r.status !== "ready") throw new Error(r.status);
  const l = r.lines.find((l) => l.key === PURCHASES_KEY);
  if (!l) throw new Error("no purchases line");
  return l;
}
const compared = (l: BenchLine): ComparedLine => {
  if (l.status !== "compared") throw new Error(`not compared: ${JSON.stringify(l)}`);
  return l;
};

describe("I-44b — the business's side, from the margin's inputs", () => {
  it("works it out from each offer's cost to deliver, at the monthly volumes", () => {
    const own = ownPurchasesShare(
      inputs({
        gross_margin: null,
        offers: [offer("soup", money(10), money(4), 100), offer("stew", money(20), money(5), 50)],
      }),
    );
    if ("needs" in own) throw new Error("needs");
    // (400 + 250) ÷ (1,000 + 1,000) = 32.5%
    expect(own.pct).toBe(32.5);
    expect(own.formula).toBe("€650 to deliver ÷ €2,000 of sales = 32.5%");
    expect(own.inputs.map((i) => i.basis)).toEqual(["DERIVED", "DERIVED"]);
    expect(own.derived_from).toContain("offers.soup.cost_to_deliver");
    expect(own.left_out).toEqual([]);
  });

  it("else from the gross margin, its basis kept", () => {
    const own = ownPurchasesShare(inputs({ gross_margin: count(62.5, "ESTIMATED") }));
    if ("needs" in own) throw new Error("needs");
    expect(own.pct).toBe(37.5);
    expect(own.formula).toBe("100.0% less your gross margin of 62.5% = 37.5%");
    expect(own.inputs).toEqual([
      { label: "Gross margin", value: "62.5%", basis: "ESTIMATED", source: "as you told me" },
    ]);
    expect(own.derived_from).toEqual(["costs.gross_margin"]);
  });

  it("never mixes currencies: an offer priced in another one is left out, by name", () => {
    const own = ownPurchasesShare(
      inputs({
        gross_margin: null,
        offers: [
          offer("soup", money(10), money(4), 100),
          offer("import", money(30, "USD"), money(20, "USD"), 10),
        ],
      }),
    );
    if ("needs" in own) throw new Error("needs");
    expect(own.pct).toBe(40);
    expect(own.left_out).toEqual(["import: it's priced in USD, not EUR."]);
    // An offer whose cost is in another currency means no offers figure at all.
    const mixed = ownPurchasesShare(
      inputs({ gross_margin: null, offers: [offer("soup", money(10), money(4, "USD"), 100)] }),
    );
    expect(mixed).toMatchObject({
      needs: [{ href: BENCH_ASK.offers }, { href: BENCH_ASK.gross_margin }],
    });
  });
});

describe("I-44b — the line, like for like only", () => {
  it("sits beside the margin, compared with the country's own cell", () => {
    const r = compareWithSimilar(inputs(), snap([PUR("IE", "I56", "TOTAL", 55)]));
    if (r.status !== "ready") throw new Error(r.status);
    expect(r.lines.map((l) => l.key)).toEqual([
      "operating_margin",
      "purchases_share",
      "turnover_per_person",
      "staff_cost_per_employee",
    ]);
    const l = compared(r.lines[1]!);
    expect(l).toMatchObject({
      unit: "percent",
      own: 30,
      bench: 55,
      own_words: "30.0%",
      bench_words: "55.0%",
      reading: "below",
      gap_words: "25 points below",
      currency: null,
      conversion: null,
    });
    expect(l.cell).toMatchObject({ geo: "IE", nace: "I56", size: "TOTAL" });
    expect(l.gap_note).toMatch(/rent, energy and services/);
  });

  it("falls back to every size with the note, as the other lines do", () => {
    const cells = [
      { geo: "IE", nace: "I56", size: "0-9", values: {} },
      PUR("IE", "I56", "TOTAL", 55),
    ];
    const l = compared(line(inputs(), snap(cells)));
    expect(l.cell.size).toBe("TOTAL");
    expect(l.cell.fallback).toContain(EVERY_SIZE_NOTE.trim());
  });

  it("never the parent code, and never the EU27 aggregate", () => {
    const parentOnly = line(inputs(), snap([PUR("IE", "I", "TOTAL", 50)]));
    expect(parentOnly).toMatchObject({ status: "refused" });
    const euOnly = line(inputs(), snap([PUR("EU27_2020", "I56", "TOTAL", 50)]));
    expect(euOnly).toMatchObject({ status: "refused" });
    expect((euOnly as { why: string }).why).toBe(
      "Eurostat publishes no purchases figure for restaurants, cafés and bars in Ireland, at your size or across every size. I don't compare this with a wider group or with the EU as a whole.",
    );
  });

  it("without the business's input, shows the sector's figure and what it needs", () => {
    const l = line(inputs({ gross_margin: null }), snap([PUR("IE", "I56", "TOTAL", 55)]));
    expect(l).toMatchObject({
      status: "missing",
      needs: [{ href: BENCH_ASK.offers }, { href: BENCH_ASK.gross_margin }],
    });
    expect((l as { why: string }).why).toMatch(
      /^Similar businesses buy in 55\.0% of their turnover \(all restaurants, cafés and bars of every size in Ireland, 2024, Eurostat\)\./,
    );
  });

  it("stays out of the large-gap rule: a far lower purchases share makes no gap", () => {
    const x = inputs();
    const r = compareWithSimilar(x, snap([PUR("IE", "I56", "TOTAL", 95)]));
    expect(largeGap(r, x)).toBeNull();
  });

  it("reads in the person's language through a Tr", () => {
    const de = { tr: trFor("de-DE", "benchmarkPurchases"), locale: "de-DE" as const };
    const own = ownPurchasesShare(inputs(), de);
    if ("needs" in own) throw new Error("needs");
    expect(own.inputs[0]?.label).toBe("Bruttomarge");
  });
});

describe("I-44b — against the committed snapshot", () => {
  it("an Irish online shop of two: Ireland's own every-size cell, never the EU's", () => {
    const l = compared(
      line(inputs({ business_type: { code: "ecommerce_store" }, team_size: count(2) }), SNAPSHOT),
    );
    expect(l.cell).toMatchObject({ geo: "IE", nace: "G479", size: "TOTAL", year: 2024 });
    expect(l.bench).toBe(97.22);
    expect(l.cell.fallback).toMatch(/keeps this confidential/);
  });
});
