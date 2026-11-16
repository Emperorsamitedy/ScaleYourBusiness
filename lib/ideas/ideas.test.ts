// TASKS-IDEAS.md — the idea check's arithmetic, its market references, its
// next test, and its refusals, each with the numbers worked by hand.

import "dotenv/config";
import { describe, expect, it } from "vitest";
import benchmarkMap from "../../specs/benchmark-map-v1.json";
import demography from "../../specs/business-demography-v1.json";
import type { IdeaAnswers } from "./check";
import { checkIdeaAnswers, evaluateIdea, ideaByToken, nextTest, runIdea } from "./check";
import type { Plan } from "./model";
import { cashPath, levers, riskiestOf, salesInMonth, workMoney } from "./model";
import { survivalFor } from "./sector";

// €20 a sale, €8 to make it, €3,000 a month fixed, 400 sales a month at full plan.
const PLAN = {
  currency: "EUR",
  price_minor: 2_000,
  variable_cost_minor: 800,
  customers_month: 400,
  fixed_month_minor: 300_000,
  startup_minor: 400_000,
  capital_minor: 1_000_000,
  ramp_months: 3,
} satisfies Plan;

const ANSWERS: IdeaAnswers = {
  sector: "restaurant",
  country: "HU",
  customer: "consumer",
  revenue_model: "one_off",
  currency: "EUR",
  price: 20,
  variable_cost: 8,
  customers_month: 400,
  fixed_month: 3_000,
  startup: 4_000,
  capital: 10_000,
  team: 3,
  ramp_months: 3,
};

describe("I-20 — the plan's own money, worked through", () => {
  it("contribution, break-even and a month at full plan", () => {
    const m = workMoney(PLAN);
    if (m.status !== "worked") throw new Error("expected worked");
    expect(m.contribution_minor).toBe(1_200);
    expect(m.break_even_customers).toBe(250); // ⌈300 000 ÷ 1 200⌉
    expect(m.at_plan).toEqual({ revenue_minor: 800_000, profit_minor: 180_000, margin_bp: 2_250 });
  });

  it("break-even rounds up: a part customer is a whole one", () => {
    const m = workMoney({ ...PLAN, fixed_month_minor: 300_001 });
    expect(m.status === "worked" && m.break_even_customers).toBe(251);
  });

  it("the cash path ramps sales straight up, rounded down", () => {
    expect([1, 2, 3, 4].map((m) => salesInMonth(400, m, 3))).toEqual([133, 266, 400, 400]);
    const c = cashPath({ ...PLAN, customers_month: 400 });
    // start 600 000; month 1: 133 × 1 200 − 300 000 = −140 400 → 459 600
    expect(c.start_minor).toBe(600_000);
    expect(c.lowest_minor).toBe(459_600);
    expect(c.lowest_month).toBe(1);
    expect(c.covers_costs_month).toBe(2); // 266 × 1 200 = 319 200 ≥ 300 000
    expect(c.runs_out_month).toBeNull();
    expect(c.shortfall_minor).toBe(0);
  });

  it("says when the money runs out, and how much more it would take", () => {
    const c = cashPath({ ...PLAN, capital_minor: 450_000, ramp_months: 12 });
    expect(c.start_minor).toBe(50_000);
    expect(c.runs_out_month).toBe(1);
    expect(c.shortfall_minor).toBeGreaterThan(0);
    expect(c.lowest_minor).toBe(-c.shortfall_minor);
  });

  it("start-up costs above the capital run out on day one", () => {
    expect(cashPath({ ...PLAN, capital_minor: 300_000 }).runs_out_month).toBe(0);
  });

  it("a sale that costs more than it brings is said plainly, with no break-even", () => {
    expect(workMoney({ ...PLAN, variable_cost_minor: 2_000 })).toEqual({
      status: "loses_per_sale",
      contribution_minor: 0,
    });
  });

  it("customers unknown: break-even still shown, the customers are the riskiest, no cash path", () => {
    const m = workMoney({ ...PLAN, customers_month: null });
    expect(m).toMatchObject({
      status: "worked",
      break_even_customers: 250,
      at_plan: null,
      cash: null,
      riskiest: "customers",
    });
  });
});

describe("I-22 — breaking points and the riskiest assumption (rule 38)", () => {
  it("each input's breaking point, holding the rest", () => {
    const ls = levers({ ...PLAN, customers_month: 400 });
    expect(ls).toEqual([
      // customers can fall from 400 to 250: 37.5 %
      { key: "customers", stated: 400, breaking_point: 250, room_bp: 3_750 },
      // price can fall to 800 + ⌈300 000 ÷ 400⌉ = 1 550: 22.5 %
      { key: "price", stated: 2_000, breaking_point: 1_550, room_bp: 2_250 },
      // variable cost can rise to 2 000 − 750 = 1 250: 56.25 %
      { key: "variable_cost", stated: 800, breaking_point: 1_250, room_bp: 5_625 },
      // fixed can rise to 400 × 1 200 = 480 000: 60 %
      { key: "fixed_month", stated: 300_000, breaking_point: 480_000, room_bp: 6_000 },
    ]);
    // The price has the least room as a share of itself — it always does in a
    // plan that covers itself — but it is a decision, so it is never ranked (D94).
    expect(riskiestOf(ls)).toBe("customers");
  });

  it("ties go to the customers, and the price is never the riskiest", () => {
    expect(
      riskiestOf([
        { key: "variable_cost", stated: 1, breaking_point: 1, room_bp: 1_000 },
        { key: "customers", stated: 1, breaking_point: 1, room_bp: 1_000 },
        { key: "price", stated: 1, breaking_point: 1, room_bp: 1 },
      ]),
    ).toBe("customers");
  });

  it("a thin margin: when each sale's own cost outweighs what it leaves, that cost is the riskiest", () => {
    // €20 price, €12 to make: €8 left. Customers can fall 6.25 %; the cost can rise only 4.17 %.
    const m = workMoney({ ...PLAN, variable_cost_minor: 1_200 });
    expect(m).toMatchObject({
      status: "worked",
      riskiest: "variable_cost",
      riskiest_basis: "least_room",
    });
  });

  it("a zero cost has no room to measure, so it is never the riskiest", () => {
    const ls = levers({ ...PLAN, variable_cost_minor: 0, customers_month: 400 });
    expect(ls.map((l) => l.key)).not.toContain("variable_cost");
  });

  it("below break-even at full plan: short, and no test until the numbers work on paper", () => {
    const m = workMoney({ ...PLAN, customers_month: 200 });
    expect(m.status === "worked" && m.short_at_plan).toBe(true);
    expect(nextTest(m, "consumer")).toBeNull();
  });
});

describe("I-31 — the next test's pass and fail are set before it runs (rule 41)", () => {
  const worked = (over: Partial<Plan>) => workMoney({ ...PLAN, ...over });

  it("customers, for consumers: a pre-sale against a share of break-even, rounded up", () => {
    expect(nextTest(worked({ customers_month: null }), "consumer")).toEqual({
      id: "presale",
      weeks: 4,
      break_even: 250,
      pass_at_least: 63, // ⌈250 × 25 %⌉
      fail_below: 25, // ⌈250 × 10 %⌉
    });
  });

  it("customers, for businesses: paid pilots", () => {
    expect(nextTest(worked({ customers_month: null }), "business")).toMatchObject({
      id: "pilots",
      conversations: 10,
      pass_at_least: 3,
    });
  });

  it("a cost: quotes, passing at the stated figure and failing at its breaking point", () => {
    const m = worked({ variable_cost_minor: 1_200 });
    expect(nextTest(m, "consumer")).toEqual({
      id: "quotes",
      weeks: 2,
      quotes: 3,
      cost: "variable_cost",
      pass_at_most_minor: 1_200,
      fail_at_least_minor: 1_250, // 2 000 − ⌈300 000 ÷ 400⌉
    });
  });

  it("a plan above the sector's revenue per person rests on its customers (D94)", () => {
    // Thin margin (cost per sale would be the riskiest), but €96,000 a year for one person.
    const r = evaluateIdea({ ...ANSWERS, variable_cost: 12, team: 1 });
    if (r.status !== "worked" || r.money.status !== "worked") throw new Error("expected worked");
    expect(r.per_person?.reading).toBe("above");
    expect(r.money.riskiest).toBe("customers");
    expect(r.money.riskiest_basis).toBe("above_sector");
    expect(r.test).toMatchObject({ id: "presale" });
  });
});

describe("I-03, I-21 — the market's side, labelled and never merged (rule 37)", () => {
  it("survival rates for a restaurant in Hungary, with table and year", () => {
    const s = survivalFor("restaurant", "HU");
    expect(s).toMatchObject({
      status: "shown",
      geo: "HU",
      nace: "I56",
      parent: false,
      dataset: "bd_9bd_sz_cl_r2",
      y1: { pct: 86.01, year: 2020 },
      y3: { pct: 51.88, year: 2020 },
      y5: { pct: 40.52, year: 2020 },
    });
  });

  it("falls back to the parent group, says so, and never to another country", () => {
    const types = (
      benchmarkMap as {
        business_types: Record<string, { nace: string | null; parent?: string | null }>;
      }
    ).business_types;
    const have = new Set(
      (demography as { cells: { geo: string; nace: string }[] }).cells
        .filter((c) => c.geo === "HU")
        .map((c) => c.nace),
    );
    const [code] =
      Object.entries(types).find(
        ([, t]) => t.nace && !have.has(t.nace) && t.parent && have.has(t.parent),
      ) ?? [];
    expect(code).toBeDefined();
    expect(survivalFor(code!, "HU")).toMatchObject({ status: "shown", parent: true });
  });

  it("no figure for an unmapped type, or outside the EU", () => {
    expect(survivalFor("other", "HU")).toEqual({ status: "none", why: "unmapped" });
    expect(survivalFor("restaurant", "GB")).toEqual({ status: "none", why: "outside_eu" });
  });

  it("margin and revenue per person beside Eurostat's, in the plan's own currency", () => {
    const r = evaluateIdea({
      ...ANSWERS,
      currency: "HUF",
      price: 6_000,
      variable_cost: 2_400,
      fixed_month: 900_000,
      startup: 1_000_000,
      capital: 3_000_000,
    });
    if (r.status !== "worked") throw new Error("expected worked");
    expect(r.margin).toMatchObject({ unit: "percent", own: 22.5, cell: { geo: "HU" } });
    expect(r.per_person).toMatchObject({ unit: "money", currency: "HUF", cell: { geo: "HU" } });
    expect(r.per_person!.cell.words).toMatch(/Eurostat/);
  });
});

describe("rules 36 and 39 — no verdict, and recruitment is never worked through", () => {
  it("a recruitment-based model gets no figures at all", () => {
    const a = checkIdeaAnswers({ ...ANSWERS, revenue_model: "recruitment", price: undefined });
    expect(a.price).toBeNull();
    expect(evaluateIdea(a)).toEqual({ status: "recruitment" });
  });

  it("the result carries numbers and references, never a verdict field", () => {
    const text = JSON.stringify(evaluateIdea(ANSWERS));
    expect(text).not.toMatch(/verdict|viable|score|success|chance/i);
  });
});

describe("checking the answers", () => {
  it("accepts the spec's answers and an unknown customer count", () => {
    expect(checkIdeaAnswers({ ...ANSWERS, customers_month: null }).customers_month).toBeNull();
  });

  it("refuses what the spec doesn't allow", () => {
    expect(() => checkIdeaAnswers({ ...ANSWERS, currency: "XYZ" })).toThrow(/currency/);
    expect(() => checkIdeaAnswers({ ...ANSWERS, price: 0 })).toThrow(/price/);
    expect(() => checkIdeaAnswers({ ...ANSWERS, price: 1.5 })).toThrow(/price/);
    expect(() => checkIdeaAnswers({ ...ANSWERS, team: 0 })).toThrow(/team/);
    expect(() => checkIdeaAnswers({ ...ANSWERS, ramp_months: 5 })).toThrow();
    expect(() => checkIdeaAnswers({ ...ANSWERS, sector: "casino" })).toThrow();
  });
});

describe("keeping and sharing a check", () => {
  it("is kept as it was made, under its token", async () => {
    const out = await runIdea({ answers: ANSWERS, locale: "en" });
    const back = await ideaByToken(out.token);
    expect(back?.result).toEqual(out.result);
    expect(await ideaByToken("not a token!")).toBeNull();
  });
});
