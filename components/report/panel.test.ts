// The diagnostic panel's rules, each with a passing and a failing case:
// a result only where the economics computed one, a refused measure kept
// as a row, a prior only where an earlier report had the same measure,
// flags only from arithmetic, and a history that keeps every superseded
// input value.

import { describe, expect, it } from "vitest";
import {
  MEASURES,
  headline,
  historyLines,
  inputLines,
  inputWords,
  panelRows,
  severityTally,
  valueText,
} from "./panel";
import type { Computed, Economics, FactMap, Finding, Rec } from "./types";

const eur = (amount_minor: number) => ({ amount_minor, currency: "EUR" });
const c = <T>(value: T, derived_from: string[] = ["a.b"]): Computed<T> => ({
  value,
  derived_from,
  formula: "f",
  confidence: 0.7,
});
const OFFER = "11111111-1111-4111-8111-111111111111";

const empty = (over: Partial<Economics> = {}): Economics => ({
  currency: "EUR",
  offers: [],
  blended_margin_pct: null,
  break_even: null,
  fixed_costs_monthly: null,
  stated_vs_computed_margin: null,
  ...over,
});

describe("panelRows — a row per measure computed or refused", () => {
  it("prints a computed figure, DERIVED, with its derivation attached", () => {
    const rows = panelRows(empty({ blended_margin_pct: c(38) }));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.result).toEqual({ text: "38.0", unit: "%" });
    expect(rows[0]!.basis).toBe("DERIVED");
    expect(rows[0]!.computed?.formula).toBe("f");
    expect(rows[0]!.flag).toBeNull();
  });

  it("keeps a refused measure as NOT COMPUTED with the reason — and drops one neither computed nor refused", () => {
    const rows = panelRows(
      empty({
        refusals: [{ what: "average order value", why: "both needed", missing: ["x.y"] }],
      }),
    );
    expect(rows.map((r) => r.id)).toEqual(["average_order_value"]);
    expect(rows[0]!.result).toBeNull();
    expect(rows[0]!.basis).toBeNull();
    expect(rows[0]!.flag?.word).toBe("NOT COMPUTED");
    expect(rows[0]!.refusal?.why).toBe("both needed");
    expect(panelRows(empty())).toEqual([]);
  });

  it("an unknown refusal still gets its own row", () => {
    const rows = panelRows(empty({ refusals: [{ what: "churn", why: "no data", missing: [] }] }));
    expect(rows[0]!.name).toBe("Churn");
    expect(rows[0]!.refusal?.why).toBe("no data");
  });

  it("money prints with its unit; break-even in units a month", () => {
    const rows = panelRows(
      empty({
        average_order_value: c(eur(4610)),
        fixed_costs_monthly: c(eur(320_000)),
        break_even: c({ units_per_month: 214 }),
      }),
    );
    const by = Object.fromEntries(rows.map((r) => [r.id, r.result]));
    expect(by["average_order_value"]).toEqual({ text: "€46.10", unit: "" });
    expect(by["fixed_costs"]).toEqual({ text: "€3,200", unit: "/ mo" });
    expect(by["break_even"]).toEqual({ text: "214", unit: "/ mo" });
  });

  it("a prior only where the earlier report computed the same measure", () => {
    const rows = panelRows(
      empty({ blended_margin_pct: c(38), average_order_value: c(eur(4610)) }),
      empty({ blended_margin_pct: c(41.2) }),
    );
    expect(rows.find((r) => r.id === "blended_margin")!.prior?.text).toBe("41.2");
    expect(rows.find((r) => r.id === "average_order_value")!.prior).toBeNull();
  });

  it("flags only from arithmetic: below cost is ACT NOW, a margin unlike yours says so", () => {
    const below = panelRows(
      empty({
        offers: [
          {
            offer_id: OFFER,
            name: "Mug",
            price: eur(1000),
            cost_to_deliver: eur(1200),
            margin_pct: c(-20),
            contribution: null,
            volume: null,
          },
        ],
      }),
    );
    expect(below[0]!.name).toBe("Margin · Mug");
    expect(below[0]!.flag).toEqual({ word: "ACT NOW · BELOW COST", tone: "alarm" });

    const differs = panelRows(
      empty({
        blended_margin_pct: c(38),
        stated_vs_computed_margin: { stated_pct: 42, computed_pct: 38, delta_pts: -4 },
      }),
    );
    expect(differs[0]!.flag?.word).toBe("DIFFERS FROM YOURS");

    const close = panelRows(
      empty({
        blended_margin_pct: c(38),
        stated_vs_computed_margin: { stated_pct: 38.4, computed_pct: 38, delta_pts: -0.4 },
      }),
    );
    expect(close[0]!.flag).toBeNull();
  });

  it("an offer with no cost is NOT COMPUTED and names the missing cost", () => {
    const rows = panelRows(
      empty({
        offers: [
          {
            offer_id: OFFER,
            name: "Mug",
            price: eur(1000),
            cost_to_deliver: null,
            margin_pct: null,
            contribution: null,
            volume: null,
          },
        ],
      }),
    );
    expect(rows[0]!.result).toBeNull();
    expect(rows[0]!.refusal?.missing).toEqual([`offers.${OFFER}.cost_to_deliver`]);
  });

  it("every measure has words for its formula", () => {
    for (const m of MEASURES) expect(m.words.length).toBeGreaterThan(20);
  });
});

describe("the head line", () => {
  const f = (severity: Finding["severity"]): Finding => ({
    area: "a",
    title: severity,
    detail: "",
    evidence: [],
    severity,
  });

  it("tallies severities most urgent first and leaves out the ones that do not occur", () => {
    expect(severityTally([f("high"), f("critical"), f("critical")])).toEqual([
      { severity: "critical", n: 2, word: "act now", tone: "alarm" },
      { severity: "high", n: 1, word: "high", tone: "drift" },
    ]);
    expect(severityTally([])).toEqual([]);
  });

  const rec = (down: number | null, up: number | null): Rec => ({
    addresses: [],
    title: "R",
    rationale: "",
    effort: "low",
    reversibility: { level: "easy", if_you_change_your_mind: "" },
    sensitivity_callouts: [],
    scenario: {
      assumptions: [],
      base_case: { case: "base", statement: "", formula: null, profit_delta_monthly: null },
      downside_case: {
        case: "downside",
        statement: "",
        formula: null,
        profit_delta_monthly: down === null ? null : eur(down),
      },
      upside_case: {
        case: "upside",
        statement: "",
        formula: null,
        profit_delta_monthly: up === null ? null : eur(up),
      },
      breakeven_condition: "",
    },
    status: "proposed",
    rejection_reason: null,
  });

  it("headlines the first recommendation the arithmetic gives a range — never a single point", () => {
    const h = headline([rec(null, 5000), rec(21_400, 338_000)], "B"); // a measured business (§6.2)
    expect(h?.index).toBe(1);
    expect(h?.range.low.amount_minor).toBe(21_400);
    expect(h?.range.high.amount_minor).toBe(338_000);
    expect(headline([rec(null, 5000)], "B")).toBeNull();
  });
});

describe("the derivation sheet", () => {
  const map: FactMap = {
    "revenue.monthly_revenue": {
      value: "41 260 EUR",
      status: "answered",
      confidence: 1,
      source_kind: "connector",
      source_detail: "stripe charges",
      observed_at: "2026-10-12T00:00:00Z",
      note: null,
    },
    [`offers.${OFFER}.name`]: {
      value: "Mug",
      status: "answered",
      confidence: 0.8,
      source_kind: "owner_input",
      note: null,
    },
  };

  it("names inputs in words, including a refusal's patterns", () => {
    expect(inputWords("offers.<id>.price", map)).toBe("price of each offer");
    expect(inputWords("costs.<fixed cost items>", map)).toBe("fixed cost items");
    expect(inputWords(`offers.${OFFER}.price`, map)).toBe("Mug · price");
    expect(inputWords("connector:stripe:revenue.daily", map)).toBe("stripe revenue daily");
    // A field of the business under "offers." is named, not read as an offer.
    expect(inputWords("offers.physical.inventory.stockout_items", map)).toBe("often out of stock");
  });

  it("prints a bare number grouped, and an option's words when the server named them", () => {
    const f = { status: "answered", source_kind: "owner_input" } as const;
    expect(valueText({ ...f, value: "3400" } as never)).toBe("3,400");
    expect(valueText({ ...f, value: "too low", value_words: "Too low" } as never)).toBe("Too low");
  });

  it("lists each input once with value, source and basis; an unrecorded one says so", () => {
    const lines = inputLines(["revenue.monthly_revenue", "revenue.monthly_revenue", "x.y"], map);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      name: "Monthly revenue",
      value: "€41,260",
      basis: "OBSERVED",
      source: "measured · stripe charges",
    });
    expect(lines[1]).toMatchObject({ value: null, basis: null, source: "not recorded" });
  });

  it("history: this report's figure first and marked, then prior and superseded inputs, newest first", () => {
    const [row] = panelRows(
      empty({ blended_margin_pct: c(38, ["revenue.monthly_revenue"]) }),
      empty({ blended_margin_pct: c(41.2) }),
    );
    const lines = historyLines({
      row: row!,
      issuedAt: "2026-10-15T10:00:00Z",
      priorAt: "2026-09-20T00:00:00Z",
      keys: ["revenue.monthly_revenue"],
      map,
      now: new Date("2026-10-17T00:00:00Z"),
      history: {
        "revenue.monthly_revenue": [
          {
            key: "revenue.monthly_revenue",
            value: "38 000 EUR",
            status: "answered",
            source_kind: "owner_input",
            source_detail: null,
            observed_at: "2026-09-14T00:00:00Z",
            recorded_at: "2026-09-14T00:00:00Z",
            superseded_at: "2026-10-12T00:00:00Z",
            note: null,
          },
        ],
      },
    });
    expect(lines.map((l) => l.date)).toEqual(["15 Oct", "12 Oct", "20 Sep"]);
    expect(lines[0]).toMatchObject({ text: "Computed 38.0 % in this report", fresh: true });
    // the owner's figure was replaced by the connector's: a measurement
    expect(lines[1]!.text).toBe("Monthly revenue was €38,000 — superseded by a newer measurement");
    expect(lines[1]!.fresh).toBe(false);
    expect(lines[2]!.text).toBe("Was 41.2 % in the previous report");
  });

  it("a refused measure's history says why, and nothing invented", () => {
    const [row] = panelRows(
      empty({ refusals: [{ what: "break-even", why: "no fixed costs", missing: [] }] }),
    );
    const lines = historyLines({
      row: row!,
      issuedAt: "2026-10-15T10:00:00Z",
      priorAt: null,
      keys: [],
      map,
      history: {},
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]!.text).toBe("Not computed in this report — no fixed costs");
  });
});
