// Feature 36 — the campaign simulator's arithmetic. What must hold:
// each model's chain at its boundaries; a missing input shows as missing,
// never as a number; every range is ordered; money stays in integers; the
// side-by-side rows are the same measures in the same units; and the
// pinned constants still agree with the figures they repeat.

import "dotenv/config";
import { describe, expect, it } from "vitest";
import { ADS } from "../ads/proposals";
import { MAX_CHANGE_SHARE } from "../ads/guard";
import { CADENCE } from "../content/plan";
import { EMAIL_READBACK } from "../trust/email-readback";
import { POST_READBACK } from "../trust/post-readback";
import type { OptionResult, SimOption } from "./model";
import {
  CONTENT_WEEKS,
  MEASURES,
  SIM,
  SimulateError,
  adsWindow,
  catalogOf,
  compareOptions,
  isShare,
  marginInput,
  optionKey,
  parseOption,
  percentile,
  simulateOption,
  spread,
  weeklyRoas,
} from "./model";
import { simulationRecord, withSimulation } from "./scenario";

import { AS_OF, bare, campaign, full } from "./fixtures";

const EMAIL: SimOption = { kind: "email", segment: "lapsed" };
const RAISE: SimOption = { kind: "ads", change: "raise", campaign_ref: "120000001", share: 0.2 };
const PAUSE: SimOption = { kind: "ads", change: "pause", campaign_ref: "120000002" };
const CONTENT: SimOption = { kind: "content" };

function rangeCell(r: OptionResult, m: (typeof MEASURES)[number]) {
  const c = r.measures[m];
  if (c.status !== "range") throw new Error(`${m} is ${c.status}`);
  return c;
}

describe("the pinned constants agree with the figures they repeat", () => {
  it("ads, email and content thresholds are the generators' and readbacks' own", () => {
    expect(SIM.ads_min_measured_days).toBe(ADS.min_measured_days);
    expect(SIM.ads_max_change_share).toBe(MAX_CHANGE_SHARE);
    expect(SIM.ads_max_change_share).toBe(ADS.max_change_share);
    expect(SIM.email_min_measured).toBe(EMAIL_READBACK.min_measured);
    expect(SIM.email_wait_days).toEqual(EMAIL_READBACK.min_days_after);
    expect(SIM.content_baseline_posts).toBe(POST_READBACK.baseline_posts);
    expect(SIM.content_min_posts).toBe(POST_READBACK.min_baseline_posts);
    expect(SIM.content_age_days).toBe(POST_READBACK.judge_age_days);
    expect(CONTENT_WEEKS).toBe(4);
    expect(CADENCE.social_organic?.per_week).toBe(3);
  });
});

describe("the measured spread", () => {
  it("is the 25th to 75th percentile, linearly interpolated", () => {
    expect(spread([1, 2, 3, 4, 5])).toEqual({ low: 2, high: 4 });
    expect(spread([10, 20])).toEqual({ low: 12.5, high: 17.5 });
    expect(spread([7])).toEqual({ low: 7, high: 7 });
    expect(spread([])).toBeNull();
    expect(percentile([0, 100], 0.25)).toBe(25);
  });

  it("orders its input: the order values arrive doesn't matter", () => {
    expect(spread([5, 1, 4, 2, 3])).toEqual(spread([1, 2, 3, 4, 5]));
  });
});

describe("options from untrusted JSON", () => {
  it("a budget change share is held to 5%–50%, both ends included", () => {
    expect(isShare(0.05)).toBe(true);
    expect(isShare(0.5)).toBe(true);
    expect(isShare(0.049)).toBe(false);
    expect(isShare(0.501)).toBe(false);
    expect(
      parseOption({ kind: "ads", change: "raise", campaign_ref: "1", share: 0.5 }),
    ).not.toBeNull();
    expect(parseOption({ kind: "ads", change: "raise", campaign_ref: "1", share: 0.6 })).toBeNull();
    expect(parseOption({ kind: "ads", change: "delete", campaign_ref: "1" })).toBeNull();
    expect(parseOption({ kind: "email", segment: "everyone" })).toBeNull();
    expect(
      parseOption({ kind: "ads", change: "new", daily_budget_minor: 12.5, currency: "EUR" }),
    ).toBeNull();
  });

  it("an option's key is stable", () => {
    expect(optionKey(RAISE)).toBe("ads:120000001:raise:20");
    expect(optionKey(parseOption(JSON.parse(JSON.stringify(RAISE)))!)).toBe(optionKey(RAISE));
  });
});

describe("the margin input", () => {
  it("spans the computed and the stated figure when both exist; missing when neither", () => {
    expect(
      marginInput({
        computed_pct: 40,
        computed_formula: "f",
        stated_pct: 30,
        stated_basis: "STATED",
      }).range,
    ).toEqual({ low: 0.3, high: 0.4 });
    const gap = marginInput({
      computed_pct: null,
      computed_formula: null,
      stated_pct: null,
      stated_basis: null,
    });
    expect(gap.range).toBeNull();
    expect(gap.basis).toBeNull();
    expect(gap.needs).toMatch(/gross margin/);
  });
});

describe("email: recipients → delivered → bought again", () => {
  it("with no past campaign, bought-again is MISSING and so is everything that rests on it", () => {
    const x = full();
    x.email.past = [];
    const r = simulateOption(EMAIL, x);
    const input = r.inputs.find((i) => i.key === "bought_again")!;
    expect(input.range).toBeNull();
    expect(input.needs).toMatch(/one sent win-back and a customer export at least 14 days/);
    for (const m of ["orders", "revenue", "profit", "reached"] as const) {
      const c = r.measures[m];
      expect(c.status).toBe("missing");
      expect(c).not.toHaveProperty("range");
    }
    // Sending costs nothing; the worst case is nothing in.
    expect(rangeCell(r, "cost").range).toEqual({ low: 0, high: 0 });
  });

  it("one past campaign, 4 of 12 measured: its own result one person either way", () => {
    const r = simulateOption(EMAIL, full());
    expect(r.inputs.find((i) => i.key === "bought_again")!.range).toEqual({
      low: 3 / 12,
      high: 5 / 12,
    });
    // 40 × 3/12 = 10, 40 × 5/12 = 16.67 → 17 orders.
    expect(rangeCell(r, "orders").range).toEqual({ low: 10, high: 17 });
    // The segment's own order values: middle half of 3,000…7,000 = 4,000…6,000.
    expect(rangeCell(r, "revenue").range).toEqual({ low: 40_000, high: 102_000 });
    // Margin 40%–50%.
    expect(rangeCell(r, "profit").range).toEqual({ low: 16_000, high: 51_000 });
    expect(rangeCell(r, "orders").bases).toEqual(["OBSERVED"]);
    expect(r.worst_words).toMatch(/Nobody buys again/);
    expect(r.worst_words).toMatch(/about 3 people would unsubscribe/); // 40 × 1/12
  });

  it("a campaign counts from 5 measured recipients — 4 is not enough", () => {
    const x = full();
    x.email.past = [{ ...x.email.past[0]!, measured: 4, returned: 1 }];
    expect(simulateOption(EMAIL, x).inputs.find((i) => i.key === "bought_again")!.range).toBeNull();
    x.email.past = [{ ...x.email.past[0]!, measured: 5, returned: 1 }];
    expect(simulateOption(EMAIL, x).inputs.find((i) => i.key === "bought_again")!.range).toEqual({
      low: 0,
      high: 0.4,
    });
  });

  it("several campaigns: the spread of their rates; another kind's campaigns don't count", () => {
    const x = full();
    const c = (measured: number, returned: number, kind: "winback" | "vip" = "winback") => ({
      kind,
      sent_on: null,
      sent: measured,
      delivered: measured,
      bounced: 0,
      harmed: 0,
      measured,
      returned,
    });
    x.email.past = [c(10, 1), c(10, 3), c(10, 9, "vip")];
    expect(simulateOption(EMAIL, x).inputs.find((i) => i.key === "bought_again")!.range).toEqual({
      low: 0.15,
      high: 0.25,
    });
  });

  it("the segment's own order values count from 5; with 4 it falls back to the shop's", () => {
    const x = full();
    expect(simulateOption(EMAIL, x).inputs.find((i) => i.key === "aov")!.source).toMatch(
      /customer list/,
    );
    x.email.segments[0]!.order_values_minor = [3_000, 4_000, 5_000, 6_000];
    expect(simulateOption(EMAIL, x).inputs.find((i) => i.key === "aov")!.source).toMatch(
      /revenue ÷ orders/,
    );
  });

  it("nobody who said yes to email: shown, but not proposable", () => {
    const x = full();
    x.email.segments[0]!.emailable = 0;
    expect(simulateOption(EMAIL, x).proposable).toEqual({
      ok: false,
      why: expect.stringMatching(/Nobody in this segment said yes/),
    });
    x.email.posture = "disabled";
    expect(simulateOption(EMAIL, x).proposable.ok).toBe(false);
  });
});

describe("ads: spend → the campaign's measured return per rolling week", () => {
  it("a 28-day window holds 22 rolling weeks; today and days before the window don't count", () => {
    const c = campaign("1", 40, 1_000, 2_000);
    c.days.push({ date: AS_OF, spend_minor: 99_999, value_minor: 0 });
    const blocks = weeklyRoas(c.days, AS_OF);
    expect(blocks).toHaveLength(SIM.ads_window_days - SIM.ads_block_days + 1);
    expect(new Set(blocks)).toEqual(new Set([2]));
    expect(adsWindow(AS_OF)).toEqual({ from: "2026-09-24", to: "2026-10-21" });
  });

  it("needs 14 measured days: 13 leaves the return MISSING, 14 gives a range", () => {
    const x = full();
    x.ads.campaigns = [campaign("120000001", 13, 1_000, 3_000)];
    const thin = simulateOption(RAISE, x);
    expect(thin.inputs.find((i) => i.key === "roas")!.range).toBeNull();
    expect(thin.measures.revenue.status).toBe("missing");
    expect(thin.proposable.ok).toBe(false);
    x.ads.campaigns = [campaign("120000001", 14, 1_000, 3_000)];
    expect(simulateOption(RAISE, x).inputs.find((i) => i.key === "roas")!.range).toEqual({
      low: 3,
      high: 3,
    });
  });

  it("a raise: extra spend × return × margin − spend, in integer minor units", () => {
    const r = simulateOption(RAISE, full());
    // €10/day × 20% × 28 days = €56 more spend.
    expect(rangeCell(r, "cost").range).toEqual({ low: 5_600, high: 5_600 });
    expect(rangeCell(r, "cost").exact).toBe(true);
    expect(rangeCell(r, "revenue").range).toEqual({ low: 16_800, high: 16_800 });
    // 16,800 × 40%–50% − 5,600.
    expect(rangeCell(r, "profit").range).toEqual({ low: 1_120, high: 2_800 });
    expect(rangeCell(r, "worst").range).toEqual({ low: 1_120, high: 1_120 });
    expect(r.measures.orders.status).toBe("none");
  });

  it("the shown arithmetic multiplies out: a measured €18.50 a day isn't printed as €19", () => {
    const x = full();
    x.ads.campaigns[0] = campaign("120000001", 28, 1_850, 5_550);
    const cost = rangeCell(simulateOption(RAISE, x), "cost");
    // 18.50 × 20% = 3.70 a day more, × 28 days = 103.60.
    expect(cost.range).toEqual({ low: 10_360, high: 10_360 });
    expect(cost.formula).toBe("€18.50 a day × +20% × 28 days");
  });

  it("a negative spend taken away is bracketed, never '− −€'", () => {
    const r = simulateOption(PAUSE, full());
    for (const m of ["profit", "worst"] as const) {
      expect(rangeCell(r, m).formula).not.toMatch(/− −/);
      expect(rangeCell(r, m).formula).toMatch(/− \(−€/);
    }
  });

  it("a pause: the spend saved and the return lost; the worst case is its best week", () => {
    const x = full();
    // Weeks vary: the first fortnight returns 0.25, the rest 0.75.
    x.ads.campaigns[1] = campaign("120000002", 28, 2_000, (i) => (i < 14 ? 500 : 1_500));
    const r = simulateOption(PAUSE, x);
    expect(rangeCell(r, "cost").range).toEqual({ low: -56_000, high: -56_000 });
    const rev = rangeCell(r, "revenue").range;
    expect(rev.low).toBeLessThanOrEqual(rev.high);
    expect(rev.high).toBeLessThan(0);
    // Worst: the week at 0.75 return stopped, at the higher margin: −56,000 × 0.75 × 0.5 + 56,000.
    expect(rangeCell(r, "worst").range.low).toBe(35_000);
  });

  it("the spend guard refuses a raise past the stated ceiling, naming the figure", () => {
    const x = full();
    x.ads.ceiling = { amount_minor: 90_000, currency: "EUR" };
    // Account €30/day + €2 raise = €32 × 30 = €960 > €900.
    const r = simulateOption(RAISE, x);
    expect(r.guard).toMatch(/960.*over your stated ceiling of €900/);
    expect(r.proposable.ok).toBe(false);
  });

  it("a new campaign with no budget typed: the spend is MISSING; it is never proposable yet", () => {
    const r = simulateOption(
      { kind: "ads", change: "new", daily_budget_minor: null, currency: "EUR" },
      full(),
    );
    expect(r.measures.cost.status).toBe("missing");
    expect(r.measures.profit.status).toBe("missing");
    expect(r.proposable.ok).toBe(false);
    const typed = simulateOption(
      { kind: "ads", change: "new", daily_budget_minor: 1_000, currency: "EUR" },
      full(),
    );
    expect(typed.inputs.find((i) => i.key === "daily")!.basis).toBe("STATED");
    expect(typed.inputs.find((i) => i.key === "roas")!.source).toMatch(
      /across your measured campaigns/,
    );
  });
});

describe("content: posts × reach → interactions → visits → orders", () => {
  it("2 measured posts leave reach MISSING; 3 give the spread", () => {
    const x = full();
    x.content.posts = x.content.posts.slice(0, 2);
    const r = simulateOption(CONTENT, x);
    expect(r.measures.reached.status).toBe("missing");
    expect(r.measures.orders.status).toBe("missing");
    x.content.posts = full().content.posts.slice(0, 3);
    expect(simulateOption(CONTENT, x).measures.reached.status).toBe("range");
  });

  it("the whole chain, with the arithmetic", () => {
    const r = simulateOption(CONTENT, full());
    // 12 posts × reach 550–850.
    expect(rangeCell(r, "reached").range).toEqual({ low: 6_600, high: 10_200 });
    // 12 × 27.5–42.5 interactions × 0.3 visits × 2% = 1.98–3.06 → 2–3 orders.
    expect(rangeCell(r, "orders").range).toEqual({ low: 2, high: 3 });
    expect(rangeCell(r, "orders").formula).toMatch(/12 posts × 27.5 – 42.5 interactions/);
    expect(rangeCell(r, "orders").bases).toEqual(["OBSERVED", "DERIVED"]);
  });

  it("visits per interaction unmeasured: MISSING, with what fills it", () => {
    const x = full();
    x.content.social_sessions = null;
    const r = simulateOption(CONTENT, x);
    expect(r.inputs.find((i) => i.key === "spi")!.needs).toMatch(
      /Google Analytics visits from social/,
    );
    expect(r.measures.revenue).toEqual({
      status: "missing",
      needs: [expect.stringMatching(/^site visits per interaction/)],
    });
  });

  it("conversion: 14 measured days are read; 13 fall back to the owner's stated figures", () => {
    const x = full();
    x.site.days = Array.from({ length: 13 }, () => ({ sessions: 100, orders: 2 }));
    x.site.stated_orders_monthly = 30;
    x.site.stated_sessions_monthly = 1_000;
    const conv = simulateOption(CONTENT, x).inputs.find((i) => i.key === "conversion")!;
    expect(conv.basis).toBe("DERIVED");
    expect(conv.range).toEqual({ low: 0.03, high: 0.03 });
    x.site.days = Array.from({ length: 14 }, () => ({ sessions: 100, orders: 2 }));
    expect(simulateOption(CONTENT, x).inputs.find((i) => i.key === "conversion")!.basis).toBe(
      "OBSERVED",
    );
  });
});

describe("every option, everywhere", () => {
  const options: SimOption[] = [
    EMAIL,
    { kind: "email", segment: "vip" },
    RAISE,
    { kind: "ads", change: "lower", campaign_ref: "120000001", share: 0.5 },
    PAUSE,
    { kind: "ads", change: "new", daily_budget_minor: 1_500, currency: "EUR" },
    CONTENT,
  ];

  it("ranges are ordered and money stays in integer minor units — measured or bare", () => {
    for (const x of [full(), bare()]) {
      for (const o of options) {
        const r = simulateOption(o, x);
        for (const m of MEASURES) {
          const c = r.measures[m];
          if (c.status !== "range") continue;
          expect(c.range.low).toBeLessThanOrEqual(c.range.high);
          if (m !== "reached" && m !== "orders") {
            expect(Number.isSafeInteger(c.range.low)).toBe(true);
            expect(Number.isSafeInteger(c.range.high)).toBe(true);
          }
        }
        for (const i of r.inputs)
          if (i.range) expect(i.range.low).toBeLessThanOrEqual(i.range.high);
      }
    }
  });

  it("a bare business gets no invented number: every input it lacks is missing, with a filler", () => {
    for (const o of options) {
      const r = simulateOption(o, bare());
      for (const i of r.inputs.filter((i) => i.range === null)) {
        expect(i.basis).toBeNull();
        expect(i.needs).toEqual(expect.any(String));
      }
      expect(r.measures.revenue.status).not.toBe("range");
      expect(r.measures.profit.status).not.toBe("range");
    }
  });
});

describe("the side by side", () => {
  it("takes 2 to 4 options — 1 and 5 are refused, and so is the same option twice", () => {
    expect(() => compareOptions([EMAIL], full())).toThrow(SimulateError);
    expect(() =>
      compareOptions([EMAIL, RAISE, PAUSE, CONTENT, { kind: "email", segment: "vip" }], full()),
    ).toThrow(/between 2 and 4/);
    expect(() => compareOptions([EMAIL, EMAIL], full())).toThrow(/same option twice/);
    expect(compareOptions([EMAIL, RAISE], full()).options).toHaveLength(2);
    expect(compareOptions([EMAIL, RAISE, PAUSE, CONTENT], full()).options).toHaveLength(4);
  });

  it("returns the same measures, in the same units and order, one cell per option", () => {
    const cmp = compareOptions([EMAIL, RAISE, CONTENT], full());
    expect(cmp.rows.map((r) => r.measure)).toEqual([...MEASURES]);
    for (const row of cmp.rows) {
      expect(row.cells).toHaveLength(3);
      expect(row.note).toBeNull();
      expect(row.unit).toBe(
        row.measure === "reached" || row.measure === "orders" ? "count" : "money",
      );
    }
    expect(cmp.options.map((o) => o.currency)).toEqual(["EUR", "EUR", "EUR"]);
  });

  it("money in two currencies is flagged on every money row, never converted (rule 1)", () => {
    const x = full();
    const cmp = compareOptions(
      [EMAIL, { kind: "ads", change: "new", daily_budget_minor: 500_000, currency: "HUF" }],
      x,
    );
    expect(cmp.rows.find((r) => r.measure === "revenue")!.note).toMatch(/EUR and HUF/);
    expect(cmp.rows.find((r) => r.measure === "orders")!.note).toBeNull();
  });
});

describe("the catalog and the attached scenario", () => {
  it("lists every kind even when nothing is measured", () => {
    const c = catalogOf(bare());
    expect(c.email.map((e) => e.key)).toEqual(["lapsed", "vip"]);
    expect(c.campaigns).toEqual([]);
    expect(catalogOf(full()).campaigns[0]).toMatchObject({ measured_days: 28, daily_minor: 1_000 });
  });

  it("the queue's range comes from the simulated profit, in integer money; gaps are named, not assumed", () => {
    const r = simulateOption(EMAIL, full());
    const base = {
      assumptions: [
        {
          statement: "path evidence",
          value: null,
          source_field: null,
          sensitivity: "low" as const,
        },
      ],
      base_case: {
        case: "base" as const,
        statement: "b",
        profit_delta_monthly: null,
        formula: null,
      },
      downside_case: {
        case: "downside" as const,
        statement: "d",
        profit_delta_monthly: null,
        formula: null,
      },
      upside_case: {
        case: "upside" as const,
        statement: "u",
        profit_delta_monthly: null,
        formula: null,
      },
      breakeven_condition: "none",
    };
    const s = withSimulation(base, r, AS_OF);
    expect(s.downside_case.profit_delta_monthly).toEqual({ amount_minor: 16_000, currency: "EUR" });
    expect(s.upside_case.profit_delta_monthly).toEqual({ amount_minor: 51_000, currency: "EUR" });
    expect(s.assumptions.at(-1)!.statement).toBe("path evidence");
    expect(s.simulation.key_rate).toMatchObject({ name: "bought_again_rate" });

    const x = full();
    x.email.past = [];
    const gap = withSimulation(base, simulateOption(EMAIL, x), AS_OF);
    expect(gap.downside_case.profit_delta_monthly).toBeNull();
    expect(gap.base_case.statement).toMatch(/Not worked out: .*Bought again after it/);
    expect(gap.simulation.measures.revenue).toBeUndefined();
    expect(simulationRecord(simulateOption(EMAIL, x), AS_OF).missing).toHaveLength(2);
  });
});
