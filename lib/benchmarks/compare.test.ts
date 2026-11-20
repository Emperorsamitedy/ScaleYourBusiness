// I-44.3: the comparison, pure. Each rule has a passing and a failing case:
// the ±15 % boundaries, the cell fallbacks, the currency conversion, the
// margin's arithmetic and what it leaves out, and every refusal.

import { describe, expect, it } from "vitest";
import type { CostLine, CountFact, MoneyFact, OfferLine } from "../cash/model";
import type { BenchInputs, BenchLine, ComparedLine } from "./compare";
import {
  EVERY_SIZE_NOTE,
  BENCH_ASK,
  compareWithSimilar,
  ownMargin,
  pickCell,
  readingOf,
  teurToMinor,
} from "./compare";
import { typeEntry } from "./map";
import type { MappedType } from "./map";
import type { BenchCell, Snapshot } from "./snapshot";
import { SNAPSHOT } from "./snapshot";

const eur = (major: number, basis: MoneyFact["basis"] = "STATED"): MoneyFact => ({
  amount_minor: Math.round(major * 100),
  currency: "EUR",
  basis,
  source: "as you told me",
  on: "2026-10-01",
});
const count = (value: number, basis: CountFact["basis"] = "STATED"): CountFact => ({
  value,
  basis,
  source: "as you told me",
});
const cost = (
  id: string,
  category: string,
  amount: MoneyFact | null,
  cadence: string | null,
  list: "fixed" | "variable" = "fixed",
): CostLine => ({ key: `costs.${id}`, label: id, category, list, amount, cadence });
const offer = (
  id: string,
  price: number,
  costTo: number | null,
  volume: number | null,
): OfferLine => ({
  key: `offers.${id}`,
  name: id,
  price: eur(price),
  cost: costTo === null ? null : eur(costTo),
  volume_month: volume === null ? null : count(volume),
});

/** A tiny snapshot: one country, one activity, its parent, a few size classes. */
function snap(cells: BenchCell[], rates: Record<string, Record<string, number>> = {}): Snapshot {
  return {
    ...SNAPSHOT,
    geos: { HU: "Hungary", IE: "Ireland" },
    nace: {
      I56: "Food and beverage service activities",
      I: "Accommodation and food service activities",
    },
    fx: { ...SNAPSHOT.fx, rates },
    cells,
  };
}

const RESTAURANT = typeEntry("restaurant") as MappedType;

function inputs(over: Partial<BenchInputs> = {}): BenchInputs {
  return {
    as_of: "2026-10-29",
    business_type: { code: "restaurant" },
    country: { raw: "Ireland", iso: "IE" },
    team_size: count(3),
    size_band: null,
    revenue: eur(20_000),
    orders_month: null,
    gross_margin: count(70),
    offers: [],
    costs: [
      cost("rent", "rent", eur(2_000), "monthly"),
      cost("wages", "salaries", eur(6_000), "monthly"),
    ],
    staff: null,
    ...over,
  };
}

const IE_CELLS: BenchCell[] = [
  {
    geo: "IE",
    nace: "I56",
    size: "TOTAL",
    values: {
      GOR_PC: { value: 25, year: 2024 },
      NETTUR_EMP_TEUR: { value: 60, year: 2024 },
      AVG_EXPN_SAL_BEN_TEUR: { value: 30, year: 2024 },
    },
  },
  {
    geo: "IE",
    nace: "I56",
    size: "0-9",
    values: { NETTUR_EMP_TEUR: { value: 50, year: 2024, flag: "e" } },
  },
];

const compared = (l: BenchLine | undefined): ComparedLine => {
  if (!l || l.status !== "compared") throw new Error(`not compared: ${JSON.stringify(l)}`);
  return l;
};

describe("above, below or about the same (±15 %)", () => {
  it("is about the same on and inside the boundary", () => {
    expect(readingOf(11.5, 10)).toBe("about the same");
    expect(readingOf(8.5, 10)).toBe("about the same");
    expect(readingOf(10, 10)).toBe("about the same");
    expect(readingOf(-6.9, -6)).toBe("about the same");
  });
  it("is above or below just past it", () => {
    expect(readingOf(11.51, 10)).toBe("above");
    expect(readingOf(8.49, 10)).toBe("below");
    expect(readingOf(-6.91, -6)).toBe("below");
    expect(readingOf(0.1, 0)).toBe("above");
    expect(readingOf(0, 0)).toBe("about the same");
  });
  it("holds for money in minor units too", () => {
    expect(readingOf(115_000, 100_000)).toBe("about the same");
    expect(readingOf(115_001, 100_000)).toBe("above");
  });
});

describe("the operating margin", () => {
  it("works out revenue less cost of sales, running costs and staff pay, and spells it out", () => {
    const m = ownMargin(inputs());
    if ("why" in m) throw new Error(m.why);
    // 20,000 − 6,000 (30% cost of sales) − 2,000 rent − 6,000 wages = 6,000 → 30%.
    expect(m.pct).toBe(30);
    expect(m.formula).toBe(
      "(€20,000 revenue − €6,000 cost of sales − €8,000 running costs) ÷ €20,000 × 100 = 30.0%",
    );
    expect(m.derived_from).toEqual(
      expect.arrayContaining([
        "revenue.monthly_revenue",
        "costs.gross_margin",
        "costs.rent.amount",
        "costs.wages.amount",
      ]),
    );
  });

  it("prefers the offers' own costs to the stated gross margin", () => {
    const m = ownMargin(
      inputs({ offers: [offer("lunch", 10, 4, 1_000), offer("dinner", 30, 9, 200)] }),
    );
    if ("why" in m) throw new Error(m.why);
    // cost share (4,000 + 1,800) ÷ (10,000 + 6,000) = 36.25% → 7,250 of 20,000.
    expect(m.inputs.find((i) => i.label === "Cost of sales")).toMatchObject({
      value: "36.3% of sales",
      basis: "DERIVED",
    });
    expect(m.pct).toBe(23.8);
    expect(m.derived_from).toContain("offers.lunch.cost_to_deliver");
    expect(m.derived_from).not.toContain("costs.gross_margin");
  });

  it("falls back to the gross margin when an offer that sells has no cost", () => {
    const m = ownMargin(
      inputs({ offers: [offer("lunch", 10, 4, 1_000), offer("dinner", 30, null, 200)] }),
    );
    if ("why" in m) throw new Error(m.why);
    expect(m.derived_from).toContain("costs.gross_margin");
  });

  it("counts per-sale costs at the volumes, and leaves out what it can't make a month", () => {
    const m = ownMargin(
      inputs({
        offers: [offer("lunch", 10, 4, 1_000)],
        costs: [
          cost("box", "packaging", eur(0.5), "per_unit", "variable"),
          cost("courier", "shipping", eur(5), "per_job", "variable"),
          cost("loan", "loan_payments", eur(900), "monthly"),
          cost("mystery", "other", null, "monthly"),
          cost("insurance", "insurance", eur(1_200), "annual"),
        ],
        team_size: count(1),
      }),
    );
    if ("why" in m) throw new Error(m.why);
    // 20,000 − 8,000 (40%) − 500 boxes − 100 insurance = 11,400 → 57%.
    expect(m.pct).toBe(57);
    expect(m.left_out).toEqual([
      "courier: it's per order, and I don't know how many orders you take a month.",
      "loan: a loan repayment, and Eurostat's rate is before interest and doesn't count the loan itself.",
      "mystery: it has no amount.",
    ]);
    expect(m.needs.map((n) => n.href)).toEqual([BENCH_ASK.orders, BENCH_ASK.costs]);
  });

  it("adds the team list's employees when the costs list has no salaries, never the owner", () => {
    const m = ownMargin(
      inputs({
        costs: [cost("rent", "rent", eur(2_000), "monthly")],
        staff: [
          { key: "operations.a", engagement: "owner", cost: eur(3_000) },
          { key: "operations.b", engagement: "employee", cost: eur(2_500) },
        ],
      }),
    );
    if ("why" in m) throw new Error(m.why);
    // 20,000 − 6,000 − 2,000 − 2,500 = 9,500 → 47.5%.
    expect(m.pct).toBe(47.5);
    expect(m.derived_from).toContain("operations.b.cost_monthly");
    expect(m.derived_from).not.toContain("operations.a.cost_monthly");
  });

  it("refuses without revenue, naming the question", () => {
    const m = ownMargin(inputs({ revenue: null }));
    expect(m).toMatchObject({ needs: [{ href: "/intake?ask=4.1a" }] });
  });

  it("refuses without any cost of sales, naming both ways to give it", () => {
    const m = ownMargin(inputs({ gross_margin: null }));
    expect("why" in m && m.needs.map((n) => n.href)).toEqual([
      BENCH_ASK.offers,
      BENCH_ASK.gross_margin,
    ]);
  });

  it("refuses when staff pay can't be known", () => {
    const noList = ownMargin(inputs({ costs: [cost("rent", "rent", eur(2_000), "monthly")] }));
    expect(noList).toMatchObject({ needs: [{ href: BENCH_ASK.staff }] });
    const unpriced = ownMargin(
      inputs({
        costs: [],
        staff: [{ key: "operations.b", engagement: "employee", cost: null }],
      }),
    );
    expect(unpriced).toMatchObject({ needs: [{ href: BENCH_ASK.staff }] });
  });

  // Review 2026-10-30: a stated gross margin already took the cost of what was sold off.
  it("with a stated gross margin, direct costs aren't taken off twice; with offers' costs they are", () => {
    const costs = [
      cost("rent", "rent", eur(2_000), "monthly"),
      cost("wages", "salaries", eur(6_000), "monthly"),
      cost("flour", "materials", eur(1_000), "monthly"),
      cost("box", "packaging", eur(0.5), "per_unit", "variable"),
      cost("cards", "payment_fees", eur(300), "monthly"),
    ];
    const stated = ownMargin(inputs({ costs }));
    if ("why" in stated) throw new Error(stated.why);
    // As the first test: 20,000 − 6,000 (30%) − 2,000 − 6,000 = 6,000 → 30%.
    expect(stated.pct).toBe(30);
    expect(stated.left_out).toEqual([
      "box: already inside the gross margin you gave.",
      "flour: already inside the gross margin you gave.",
      "cards: already inside the gross margin you gave.",
    ]);
    expect(stated.derived_from).not.toContain("costs.flour.amount");
    const costed = ownMargin(inputs({ costs, offers: [offer("lunch", 10, 4, 1_000)] }));
    if ("why" in costed) throw new Error(costed.why);
    // 20,000 − 8,000 (40%) − 500 boxes − 2,000 − 6,000 − 1,000 − 300 = 2,200 → 11%.
    expect(costed.pct).toBe(11);
    expect(costed.left_out).toEqual([]);
  });

  // Review 2026-10-30: a pay line that can't be counted used to drop out of the margin.
  it("refuses when a salaries line has no amount, or is in another currency", () => {
    for (const wages of [
      cost("wages", "salaries", null, "monthly"),
      cost("wages", "salaries", { ...eur(6_000), currency: "HUF" }, "monthly"),
      cost("wages", "salaries", eur(6_000), null),
    ]) {
      const m = ownMargin(inputs({ costs: [cost("rent", "rent", eur(2_000), "monthly"), wages] }));
      expect(m, JSON.stringify(wages)).toMatchObject({
        why: expect.stringMatching(
          /^The pay line wages on your costs list has no monthly amount in EUR/,
        ),
        needs: [{ href: BENCH_ASK.costs }],
      });
      expect("pct" in m).toBe(false);
    }
  });

  it("needs no staff pay for a one-person business", () => {
    const m = ownMargin(inputs({ costs: [], team_size: count(1) }));
    expect("pct" in m && m.pct).toBe(70);
  });
});

describe("which Eurostat cell", () => {
  const s = snap([
    ...IE_CELLS,
    {
      geo: "IE",
      nace: "I56",
      size: "10-19",
      values: { GOR_PC: { missing: "confidential", year: 2024 } },
    },
    { geo: "IE", nace: "I", size: "10-19", values: { NETTUR_EMP_TEUR: { value: 70, year: 2023 } } },
  ]);

  it("passes over a size class Eurostat never publishes, naming no gap for it", () => {
    const p = pickCell(s, "IE", RESTAURANT, ["2-9", "0-9"], "NETTUR_EMP_TEUR");
    expect(p?.cell).toMatchObject({ size: "0-9", flag: "estimated" });
    expect(p?.cell.words).toBe(
      "all restaurants, cafés and bars with up to 9 people in Ireland, 2024, Eurostat",
    );
    expect(p?.cell.fallback).toBeNull();
  });

  it("names the gap when a published size class lacks the figure", () => {
    const p = pickCell(s, "IE", RESTAURANT, ["0-9"], "GOR_PC");
    expect(p?.cell).toMatchObject({ size: "TOTAL" });
    expect(p?.cell.fallback).toBe(
      "Eurostat doesn't publish this for restaurants, cafés and bars with up to 9 people in Ireland, so this is restaurants, cafés and bars of every size in Ireland." +
        EVERY_SIZE_NOTE,
    );
  });

  it("is exact when the first cell tried has it", () => {
    expect(pickCell(s, "IE", RESTAURANT, ["0-9"], "NETTUR_EMP_TEUR")?.cell.fallback).toBeNull();
  });

  it("falls back to every size, saying a confidential cell is confidential", () => {
    const p = pickCell(s, "IE", RESTAURANT, ["10-19"], "GOR_PC");
    expect(p?.cell).toMatchObject({ nace: "I56", size: "TOTAL", year: 2024 });
    expect(p?.cell.fallback).toBe(
      "Eurostat keeps this confidential (2024) for restaurants, cafés and bars with 10 to 19 people in Ireland, so this is restaurants, cafés and bars of every size in Ireland." +
        EVERY_SIZE_NOTE,
    );
  });

  it("adds no every-size note when every size was the first cell tried", () => {
    const p = pickCell(s, "IE", RESTAURANT, [], "GOR_PC");
    expect(p?.cell).toMatchObject({ size: "TOTAL" });
    expect(p?.cell.fallback).toBeNull();
  });

  it("falls back to the parent code when the code has nothing", () => {
    const only = snap([
      { geo: "IE", nace: "I", size: "TOTAL", values: { GOR_PC: { value: 9, year: 2024 } } },
    ]);
    const p = pickCell(only, "IE", RESTAURANT, ["0-9"], "GOR_PC");
    expect(p?.cell).toMatchObject({ nace: "I", size: "TOTAL" });
    expect(p?.cell.words).toBe(
      "all places to stay, restaurants, cafés and bars of every size in Ireland, 2024, Eurostat",
    );
  });

  it("finds nothing when nothing is published", () => {
    expect(pickCell(snap([]), "IE", RESTAURANT, ["0-9"], "GOR_PC")).toBeNull();
  });

  it("names an estimate as one", () => {
    const p = pickCell(snap(IE_CELLS), "IE", RESTAURANT, ["0-9"], "NETTUR_EMP_TEUR");
    expect(p?.cell.flag).toBe(SNAPSHOT.flags.e ?? "e");
  });
});

describe("the currency", () => {
  const s = snap([], { HUF: { "2024": 395.3 } });
  it("converts thousands of euro to integer minor units at the year's average", () => {
    // 35.1 thousand euro × 395.3 = 13,875,030 HUF, in minor units (exponent 2).
    expect(teurToMinor(s, 35.1, "HUF", 2024)).toEqual({ minor: 1_387_503_000, rate: 395.3 });
    expect(teurToMinor(s, 35.1, "EUR", 2024)).toEqual({ minor: 3_510_000, rate: 1 });
  });
  it("refuses a currency or year it has no rate for", () => {
    expect(teurToMinor(s, 35.1, "HUF", 2023)).toBeNull();
    expect(teurToMinor(s, 35.1, "PLN", 2024)).toBeNull();
  });
  it("compares a forint business in forint, saying the rate", () => {
    const huf = (major: number): MoneyFact => ({
      ...eur(0),
      amount_minor: major * 100,
      currency: "HUF",
    });
    const r = compareWithSimilar(
      inputs({
        country: { raw: "Hungary", iso: "HU" },
        revenue: huf(1_200_000),
        team_size: count(2),
      }),
      snap(
        [
          {
            geo: "HU",
            nace: "I56",
            size: "0-9",
            values: { NETTUR_EMP_TEUR: { value: 30, year: 2024 } },
          },
        ],
        {
          HUF: { "2024": 395.3 },
        },
      ),
    );
    if (r.status !== "ready") throw new Error(r.status);
    const t = compared(r.lines.find((l) => l.key === "turnover_per_person"));
    // Own: 1,200,000 × 12 ÷ 2 = 7,200,000 HUF; Eurostat: 30 × 1000 × 395.3 = 11,859,000 HUF.
    expect(t.own).toBe(720_000_000);
    expect(t.bench).toBe(1_185_900_000);
    expect(t.currency).toBe("HUF");
    expect(t.reading).toBe("below");
    expect(t.gap_words).toBe("4,659,000 HUF (39%) below");
    expect(t.conversion).toBe(
      "Converted from euros at 395.30 HUF to the euro, 2024's average (Eurostat, ert_bil_eur_a).",
    );
  });
  it("refuses the line when the rate is missing", () => {
    const huf: MoneyFact = { ...eur(0), amount_minor: 100_000_000, currency: "HUF" };
    const r = compareWithSimilar(
      inputs({ country: { raw: "Hungary", iso: "HU" }, revenue: huf }),
      snap([
        {
          geo: "HU",
          nace: "I56",
          size: "TOTAL",
          values: { NETTUR_EMP_TEUR: { value: 30, year: 2024 } },
        },
      ]),
    );
    if (r.status !== "ready") throw new Error(r.status);
    expect(r.lines.find((l) => l.key === "turnover_per_person")).toMatchObject({
      status: "refused",
    });
  });
});

describe("the three lines together", () => {
  it("compares margin, turnover per person and staff cost, each naming its cell", () => {
    const r = compareWithSimilar(
      inputs({
        staff: [
          { key: "operations.a", engagement: "owner", cost: null },
          { key: "operations.b", engagement: "employee", cost: eur(3_000) },
          { key: "operations.c", engagement: "employee", cost: eur(3_000) },
        ],
      }),
      snap(IE_CELLS),
    );
    if (r.status !== "ready") throw new Error(r.status);
    expect(r.head).toMatchObject({
      group: "restaurants, cafés and bars",
      country: "Ireland",
      size: "0-9",
      size_via: "team_size",
    });
    // I-44b: the purchases share sits beside the margin (lib/benchmarks/purchases.test.ts).
    const [m, , t, sc] = r.lines;
    expect(compared(m)).toMatchObject({
      own: 30,
      bench: 25,
      reading: "above",
      gap_words: "5.0 points above",
    });
    expect(compared(m).cell.fallback).toContain(
      "so this is restaurants, cafés and bars of every size in Ireland",
    );
    // 20,000 × 12 ÷ 3 = €80,000 against €50,000.
    expect(compared(t)).toMatchObject({
      own: 8_000_000,
      bench: 5_000_000,
      reading: "above",
      gap_words: "€30,000 (60%) above",
    });
    // 6,000 × 12 ÷ 2 = €36,000 against €30,000: 20% above.
    expect(compared(sc)).toMatchObject({ own: 3_600_000, bench: 3_000_000, reading: "above" });
    expect(compared(sc).formula).toBe("€6,000 a month × 12 ÷ 2 employees = €36,000");
    for (const l of r.lines) expect(l.gap_note.length).toBeGreaterThan(40);
    expect(r.caveat).toBe(
      "These are totals across every business in the group, not a typical business.",
    );
  });

  it("says what each missing line needs", () => {
    const r = compareWithSimilar(inputs({ revenue: null, team_size: null }), snap(IE_CELLS));
    if (r.status !== "ready") throw new Error(r.status);
    expect(r.head.size_via).toBe("none");
    expect(r.lines[0]).toMatchObject({ status: "missing", needs: [{ href: BENCH_ASK.revenue }] });
    expect(r.lines[2]).toMatchObject({ status: "missing" });
    expect((r.lines[2] as { needs: { href: string }[] }).needs.map((n) => n.href)).toEqual([
      BENCH_ASK.revenue,
      BENCH_ASK.team_size,
    ]);
    expect(r.lines[3]).toMatchObject({ status: "missing", needs: [{ href: BENCH_ASK.staff }] });
  });

  it("refuses the staff line with no employees, and any line with no cell", () => {
    const r = compareWithSimilar(
      inputs({
        staff: [{ key: "operations.a", engagement: "owner", cost: null }],
        team_size: count(1),
      }),
      snap([]),
    );
    if (r.status !== "ready") throw new Error(r.status);
    expect(r.lines[0]).toMatchObject({ status: "refused" });
    expect(r.lines[3]).toMatchObject({
      status: "refused",
      why: "Your team list has no employees, so there's no staff cost to compare.",
    });
  });
});

describe("the refusals before any line", () => {
  it("asks for the type", () => {
    expect(compareWithSimilar(inputs({ business_type: null }))).toMatchObject({
      status: "no_type",
      needs: [{ href: BENCH_ASK.type }],
    });
  });
  it("names no comparison for a type with no honest match, or one it doesn't know", () => {
    const r = compareWithSimilar(inputs({ business_type: { code: "nonprofit" } }));
    expect(r).toMatchObject({ status: "unmapped", type_code: "nonprofit" });
    expect(compareWithSimilar(inputs({ business_type: "agriculture" }))).toMatchObject({
      status: "unmapped",
    });
    expect(compareWithSimilar(inputs({ business_type: "spaceport" }))).toMatchObject({
      status: "unmapped",
    });
  });
  it("asks for the country, or says it can't read it", () => {
    expect(compareWithSimilar(inputs({ country: null }))).toMatchObject({
      status: "no_country",
      needs: [{ href: BENCH_ASK.country }],
    });
    expect(compareWithSimilar(inputs({ country: { raw: "Atlantis", iso: null } }))).toMatchObject({
      status: "no_country",
      why: 'I can\'t tell which country "Atlantis" is.',
    });
  });
  it("says Eurostat doesn't cover a country outside the EU", () => {
    expect(compareWithSimilar(inputs({ country: { raw: "United Kingdom", iso: "GB" } }))).toEqual({
      status: "outside_eu",
      country: "United Kingdom",
      why: "Eurostat's figures cover the 27 EU countries, and United Kingdom isn't one of them.",
    });
  });
  it("compares a business in an EU country", () => {
    expect(compareWithSimilar(inputs()).status).toBe("ready");
  });
});

describe("against the committed snapshot", () => {
  it("compares an Irish online shop of two with a named, dated cell", () => {
    const r = compareWithSimilar(
      inputs({
        business_type: { code: "ecommerce_store" },
        team_size: count(2),
        revenue: eur(38_000, "OBSERVED"),
      }),
    );
    if (r.status !== "ready") throw new Error(r.status);
    const t = compared(r.lines[2]);
    expect(t.cell).toMatchObject({ geo: "IE", nace: "G479", size: "0-9", year: 2024 });
    expect(t.cell.words).toBe(
      "all online and mail-order shops with up to 9 people in Ireland, 2024, Eurostat",
    );
    expect(t.inputs[0]).toMatchObject({ basis: "OBSERVED" });
    const m = compared(r.lines[0]);
    expect(m.cell).toMatchObject({ nace: "G479", size: "TOTAL" });
    expect(m.cell.fallback).toMatch(
      /^Eurostat doesn't publish this for online and mail-order shops with up to 9 people in Ireland/,
    );
  });
});
