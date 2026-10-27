// P5-07 — the 13-week cash forecast, pure. Every rule with a passing and a
// failing case: rule 25 (history window, sources, ranges, ASSUMED by name,
// an honest refusal under the minimum), rule 1 (one currency, integer minor
// units), the cost cadences, debt, the payout delay and the season.

import { describe, expect, it } from "vitest";
import { SEASONS, addDays } from "../seasons/forecast";
import { TODAY, baseInputs, cost, daily, eur, offer } from "./fixtures";
import type { CashForecast, CashReady, CashRefusal } from "./model";
import { CASH, arrivals, blockSum, forecastCash } from "./model";
import { PAYOUT_DAYS, PAYOUT_UNKNOWN, payoutFor } from "./payout";

function ready(f: CashForecast): CashReady {
  if (f.status !== "ready") throw new Error(`expected a forecast, got ${f.reason}: ${f.headline}`);
  return f;
}
function refused(f: CashForecast): CashRefusal {
  if (f.status !== "refused") throw new Error("expected a refusal");
  return f;
}

describe("P5-07 — the pinned windows", () => {
  it("13 weeks ahead, 8 complete weeks of the last 13 needed, the season bar shared with lib/seasons", () => {
    expect(CASH.horizon_weeks).toBe(13);
    expect(CASH.recent_weeks).toBe(13);
    expect(CASH.min_weeks).toBe(8);
    expect(CASH.quiet_index).toBe(SEASONS.quiet_index);
  });
});

describe("rule 25 — it refuses below the minimum, saying how much there is", () => {
  it("passes: exactly 8 complete weeks forecast", () => {
    const f = forecastCash(baseInputs({ revenue: daily(TODAY, 56, () => 100_000) }));
    expect(ready(f).pattern.recent_complete).toBe(8);
  });

  it("fails: 7 complete weeks refuse, with the count, what it can and can't say, and when", () => {
    const f = refused(forecastCash(baseInputs({ revenue: daily(TODAY, 49, () => 100_000) })));
    expect(f.reason).toBe("too_little");
    expect(f.headline).toBe(
      "I have 7 complete weeks of your revenue; a 13-week cash forecast needs 8.",
    );
    expect(f.history).toMatchObject({ complete_weeks: 7, needed_weeks: 8, covered_days: 49 });
    expect(f.ready_on).toBe(addDays(TODAY, 7));
    expect(f.can.length).toBeGreaterThan(0);
    expect(f.cannot.join(" ")).toMatch(/industry average isn't your history/);
  });

  it("a gap day makes a week incomplete — it isn't guessed as zero", () => {
    const series = daily(TODAY, 56, () => 100_000);
    (series.values as Map<string, number>).delete(addDays(TODAY, -3));
    const f = refused(forecastCash(baseInputs({ revenue: series })));
    expect(f.history?.complete_weeks).toBe(7);
  });

  it("nothing measured: refuses and says what to connect", () => {
    const f = refused(forecastCash(baseInputs({ revenue: null })));
    expect(f.reason).toBe("no_history");
    expect(f.needs[0]?.href).toBe("/connections");
  });

  it("no cash figure: refuses; 'I don't know' is said back as such (rule 5)", () => {
    const unknown = refused(forecastCash(baseInputs({ cash: { status: "unknown" } })));
    const missing = refused(forecastCash(baseInputs({ cash: { status: "missing" } })));
    expect(unknown.reason).toBe("no_cash");
    expect(unknown.headline).toMatch(/you don't know/);
    expect(missing.headline).not.toMatch(/you don't know/);
    expect(missing.needs[0]?.href).toBe("/intake?ask=5.3e");
  });

  it("states its window, its sources and what it ASSUMES, by name", () => {
    const f = ready(forecastCash(baseInputs()));
    expect(f.pattern.from).toBe(addDays(TODAY, -91));
    expect(f.pattern.to).toBe(addDays(TODAY, -1));
    const labels = f.sources.map((s) => s.label);
    expect(labels).toEqual([
      "Cash today",
      "Money in",
      "Payout timing",
      "Fixed costs",
      "Per-sale costs",
      "Debt repayments",
      "The line",
    ]);
    expect(f.sources.find((s) => s.label === "Money in")?.basis).toBe("OBSERVED");
    expect(f.assumptions[0]).toMatch(/With under a year of history no season is known/);
    expect(f.assumptions.join(" ")).toMatch(/Nothing else changes/);
  });

  it("a range, never a point: low ≤ high every week, and apart when the weeks vary", () => {
    const f = ready(
      forecastCash(
        baseInputs({
          revenue: daily(TODAY, 120, (_d, i) => (i % 7 === 0 ? 40_000 : 100_000) + i * 500),
        }),
      ),
    );
    for (const w of f.weeks) {
      expect(w.sales.low).toBeLessThanOrEqual(w.sales.high);
      expect(w.balance.low).toBeLessThanOrEqual(w.balance.high);
    }
    expect(f.end.low).toBeLessThan(f.end.high);
  });
});

describe("money in — the business's own weeks", () => {
  it("with under a year, every week is the middle half of the recent weeks", () => {
    // Weeks of 700, 700 … then rising: the quartiles of the 13 recent blocks.
    const f = ready(forecastCash(baseInputs({ revenue: daily(TODAY, 91, () => 100_000) })));
    expect(f.pattern.kind).toBe("recent");
    expect(f.weeks[0]?.sales).toEqual({ low: 700_000, high: 700_000 });
    // Paid in cash: money in is the sales, the same week.
    expect(f.weeks[3]?.money_in).toEqual({ low: 700_000, high: 700_000 });
    expect(f.weeks).toHaveLength(13);
    expect(f.weeks[12]?.end).toBe(addDays(TODAY, 90));
  });

  it("with a year, each week is the same week last year × the recent growth range", () => {
    // Last year's weeks ran at 1,000 a day; the last 8 weeks at 1,100 (10% up).
    const series = daily(TODAY, 430, (day) => (day >= addDays(TODAY, -56) ? 110_000 : 100_000));
    const f = ready(forecastCash(baseInputs({ revenue: series })));
    expect(f.pattern.kind).toBe("season");
    expect(f.pattern.growth).toEqual({ low: 1.1, high: 1.1 });
    const ly = blockSum(series.values, addDays(TODAY, -364))!;
    expect(f.weeks[0]?.sales).toEqual({ low: Math.round(ly * 1.1), high: Math.round(ly * 1.1) });
    expect(f.weeks[0]?.last_year?.value).toBe(ly);
    expect(f.assumptions[0]).toMatch(/same week last year/);
  });

  it("under the season bar (49 complete weeks of 52), it stays with the recent weeks", () => {
    const series = daily(TODAY, 430, () => 100_000);
    for (let j = 0; j < 3; j++)
      (series.values as Map<string, number>).delete(addDays(TODAY, -60 - 7 * j));
    const f = ready(forecastCash(baseInputs({ revenue: series })));
    expect(f.pattern.kind).toBe("recent");
  });
});

describe("the payout delay", () => {
  it("arrivals: a sale lands `delay` days later, last week's sales in transit arrive first", () => {
    // 7 a day forecast; 70 a day in the past; a 3-day delay.
    const got = arrivals([49, 49], () => 70, 3);
    // Week 0: the last 3 past days (210) + forecast days 0–3 (4 × 7).
    expect(got).toEqual([210 + 28, 49]);
  });

  it("the cautious end takes the slow end of the provider's range", () => {
    const f = ready(
      forecastCash(baseInputs({ payout: { provider: "stripe", methods: ["online_payment"] } })),
    );
    expect(f.payout.days).toEqual(PAYOUT_DAYS.stripe);
    // Slow end, 7 days: the whole of last week arrives in week 0; fast end, 2 days.
    expect(f.weeks[0]?.money_in.low).toBe(700_000);
    expect(f.weeks[1]?.money_in).toEqual({ low: 700_000, high: 700_000 });
  });

  it("customers paying only in cash or by transfer: no delay; no provider named: the widest", () => {
    expect(
      payoutFor({ provider: "stripe", methods: ["cash", "bank_transfer"], series_provider: null })
        .days.high,
    ).toBe(0);
    const none = payoutFor({ provider: null, methods: ["card"], series_provider: "shopify" });
    expect(none.days).toEqual(PAYOUT_UNKNOWN);
    expect(payoutFor({ provider: null, methods: null, series_provider: "stripe" }).code).toBe(
      "stripe",
    );
    const f = ready(forecastCash(baseInputs({ payout: { provider: null, methods: ["card"] } })));
    expect(f.needs.map((n) => n.href)).toContain("/intake?ask=4.2b");
  });
});

describe("money out — by stated frequency (5.1, 5.2)", () => {
  it("monthly on the 1st, quarterly in January only, a yearly cost a twelfth at a time", () => {
    const f = ready(
      forecastCash(
        baseInputs({
          costs: [
            cost("Rent", 1200, "monthly"),
            cost("VAT return", 3900, "quarterly"),
            cost("Insurance", 1200, "annual"),
          ],
        }),
      ),
    );
    // 1 Nov is day 5 (week 0), 1 Dec day 35 (week 5), 1 Jan day 66 (week 9).
    const due = (k: number) => f.weeks[k]!.due.map((d) => `${d.label}:${d.amount_minor}`);
    expect(due(0)).toEqual(["Rent:120000", "Insurance:10000"]);
    expect(due(5)).toEqual(["Rent:120000", "Insurance:10000"]);
    expect(due(9)).toEqual(["Rent:120000", "VAT return:390000", "Insurance:10000"]);
    expect(due(1)).toEqual([]);
    expect(f.weeks[9]?.fixed_out).toBe(520_000);
    expect(f.fixed_monthly).toBe(120_000 + 130_000 + 10_000);
    expect(f.assumptions.join(" ")).toMatch(/Quarterly costs go out on the 1st of January/);
    expect(f.assumptions.join(" ")).toMatch(/set aside a twelfth/);
  });

  it("a cost with no amount or no frequency is named, not guessed", () => {
    const f = ready(
      forecastCash(
        baseInputs({
          costs: [
            { ...cost("Software", 0, "monthly"), amount: null },
            { ...cost("Cleaner", 200, "monthly"), cadence: null },
          ],
        }),
      ),
    );
    expect(f.left_out).toEqual([
      "Software has no amount, so it isn't counted.",
      "Cleaner has no frequency, so I can't place it in a week.",
    ]);
    expect(f.weeks.every((w) => w.fixed_out === 0)).toBe(true);
  });

  it("rule 1: a cost in another currency is left out by name, never converted", () => {
    const usd = cost("US software", 50, "monthly", {
      amount: { ...eur(50), currency: "USD" },
    });
    const withIt = ready(forecastCash(baseInputs({ costs: [usd] })));
    const without = ready(forecastCash(baseInputs()));
    expect(withIt.end).toEqual(without.end);
    expect(withIt.left_out[0]).toMatch(/is in USD and your cash is in EUR; I don't convert/);
  });

  it("rule 1: cash and sales in two currencies refuse rather than mix", () => {
    const f = refused(
      forecastCash(baseInputs({ revenue: daily(TODAY, 120, () => 100_000, { currency: "USD" }) })),
    );
    expect(f.reason).toBe("currency");
  });

  it("per-sale costs ride on each week's sales, at the share the stated offers give", () => {
    const f = ready(
      forecastCash(
        baseInputs({
          offers: [offer("Mug", 10, 3, 100)],
          costs: [cost("Packaging", 0.5, "per_unit")],
        }),
      ),
    );
    // (3 × 100 + 0.5 × 100) ÷ (10 × 100) = 35%.
    expect(f.variable.ratio).toBeCloseTo(0.35, 10);
    expect(f.weeks[1]?.variable_out).toEqual({ low: 245_000, high: 245_000 });
  });

  it("per-order costs use the measured orders beside the series", () => {
    const f = ready(
      forecastCash(
        baseInputs({
          volume: { noun: "orders", values: daily(TODAY, 120, () => 20).values },
          costs: [cost("Courier", 5, "per_job")],
        }),
      ),
    );
    // 20 orders on €1,000 a day: €5 × 20 ÷ €1,000 = 10%.
    expect(f.variable.ratio).toBeCloseTo(0.1, 10);
  });

  it("per-piece costs with no stated volumes are named as missing, not counted", () => {
    const f = ready(
      forecastCash(
        baseInputs({ offers: [offer("Mug", 10, 3, null)], costs: [cost("Box", 1, "per_unit")] }),
      ),
    );
    expect(f.variable.ratio).toBe(0);
    expect(f.needs.map((n) => n.href)).toContain("/intake?ask=3.1");
  });
});

describe("debt (5.3c) — counted only where a repayment is stated", () => {
  it("a loan payment on the costs list is its own line, not a fixed cost", () => {
    const f = ready(
      forecastCash(
        baseInputs({
          debt: { status: "known", fact: eur(12_000) },
          costs: [cost("Bank loan", 450, "monthly", { category: "loan_payments" })],
        }),
      ),
    );
    expect(f.weeks[0]?.debt_out).toBe(45_000);
    expect(f.weeks[0]?.fixed_out).toBe(0);
    expect(f.debt_monthly).toBe(45_000);
  });

  it("debt with no repayment listed: none counted, and the screen says so", () => {
    const f = ready(forecastCash(baseInputs({ debt: { status: "known", fact: eur(12_000) } })));
    expect(f.debt_monthly).toBe(0);
    expect(f.left_out.join(" ")).toMatch(/You carry €12,000 of debt, but no repayment/);
  });
});

describe("the balance", () => {
  it("walks from the stated cash: start + money in − money out, week by week, in integers", () => {
    const f = ready(forecastCash(baseInputs({ costs: [cost("Rent", 1200, "monthly")] })));
    // Week 0: 5,000 + 7,000 − 1,200.
    expect(f.weeks[0]?.balance).toEqual({ low: 1_080_000, high: 1_080_000 });
    for (const w of f.weeks) {
      for (const v of [w.balance.low, w.balance.high, w.money_in.low, w.variable_out.high]) {
        expect(Number.isSafeInteger(v)).toBe(true);
      }
    }
  });

  it("the line is the stated buffer, else an empty account", () => {
    expect(ready(forecastCash(baseInputs())).line).toMatchObject({
      kind: "buffer",
      amount_minor: 200_000,
    });
    const none = ready(forecastCash(baseInputs({ buffer: { status: "unknown" } })));
    expect(none.line).toMatchObject({ kind: "zero", amount_minor: 0 });
  });
});
