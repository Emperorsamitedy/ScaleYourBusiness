// I-32, I-51, I-52: a test read against its own lines, the plan against
// the first measured month, and the first connector — boundaries both ways.

import { describe, expect, it } from "vitest";
import type { NextTest } from "./check";
import { firstConnector, planVsActual, scoreTest } from "./progress";

const presale: NextTest = {
  id: "presale",
  weeks: 4,
  pass_at_least: 63,
  fail_below: 25,
  break_even: 250,
};
const pilots: NextTest = {
  id: "pilots",
  weeks: 3,
  conversations: 10,
  pass_at_least: 3,
  fail_at_most: 0,
};
const quotes: NextTest = {
  id: "quotes",
  weeks: 2,
  quotes: 3,
  cost: "variable_cost",
  pass_at_most_minor: 1_200,
  fail_at_least_minor: 1_250,
};

describe("I-32 — a result is read against the lines set before it ran (rule 41)", () => {
  it("a pre-sale: pass at the line, fail below its fail line, between in between", () => {
    expect(scoreTest(presale, 63)).toBe("pass");
    expect(scoreTest(presale, 62)).toBe("between");
    expect(scoreTest(presale, 25)).toBe("between");
    expect(scoreTest(presale, 24)).toBe("fail");
  });

  it("pilots: three is a pass, none a fail", () => {
    expect(scoreTest(pilots, 3)).toBe("pass");
    expect(scoreTest(pilots, 2)).toBe("between");
    expect(scoreTest(pilots, 0)).toBe("fail");
  });

  it("quotes: at or under the stated cost passes, at or over the breaking point fails", () => {
    expect(scoreTest(quotes, 1_200)).toBe("pass");
    expect(scoreTest(quotes, 1_201)).toBe("between");
    expect(scoreTest(quotes, 1_249)).toBe("between");
    expect(scoreTest(quotes, 1_250)).toBe("fail");
  });

  it("refuses a result that isn't a whole number from zero", () => {
    expect(() => scoreTest(presale, -1)).toThrow();
    expect(() => scoreTest(presale, 1.5)).toThrow();
  });
});

describe("I-51 — the plan against the first measured month, shown not swapped", () => {
  const planned = { amount_minor: 800_000, currency: "EUR" };

  it("scales the measured days to the plan's month and gives the gap", () => {
    expect(
      planVsActual({ planned, measured: { sum_minor: 600_000, days: 30, currency: "EUR" } }),
    ).toEqual({
      status: "compared",
      currency: "EUR",
      planned_minor: 800_000,
      actual_minor: 600_000,
      days_measured: 30,
      delta_bp: -2_500,
    });
    // 45 days of 900 000 is 600 000 per 30 days.
    expect(
      planVsActual({ planned, measured: { sum_minor: 900_000, days: 45, currency: "EUR" } }),
    ).toMatchObject({ actual_minor: 600_000 });
  });

  it("waits for thirty measured days", () => {
    expect(
      planVsActual({ planned, measured: { sum_minor: 1, days: 29, currency: "EUR" } }),
    ).toEqual({ status: "too_early", days_measured: 29, needed: 30 });
  });

  it("never converts: another currency is said, not compared", () => {
    expect(
      planVsActual({ planned, measured: { sum_minor: 1, days: 30, currency: "HUF" } }),
    ).toMatchObject({ status: "other_currency" });
  });

  it("no plan, nothing to compare", () => {
    expect(
      planVsActual({ planned: null, measured: { sum_minor: 1, days: 30, currency: "EUR" } }),
    ).toEqual({ status: "no_plan" });
  });
});

describe("I-52 — the first connector, as data", () => {
  it("by revenue model, then the kind of business, then Stripe", () => {
    expect(firstConnector("subscription", "ecommerce_store")).toBe("stripe");
    expect(firstConnector("one_off", "ecommerce_store")).toBe("shopify");
    expect(firstConnector("one_off", "cafe")).toBe("square");
    expect(firstConnector("one_off", "consulting")).toBe("stripe");
  });
});
