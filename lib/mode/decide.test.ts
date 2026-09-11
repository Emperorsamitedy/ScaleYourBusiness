// Session H — P1-42/45. Every §9 rule with a passing and a failing
// case. The rule under test is the safety boundary of the whole later
// product: instant mode is what lets the system act on a business, so
// each test names the situation where getting it wrong would hurt.

import { describe, expect, it } from "vitest";
import type { ModeDecisionInputs, ModeRuling } from "./decide";
import { AD_SPEND_8W_MINOR, decideMode } from "./decide";

/** The §9 instant archetype: brand-new, tiny, nothing to break. */
const IDEA_STAGE: ModeDecisionInputs = {
  stage: "idea",
  has_revenue: false,
  monthly_order_count: null,
  months_operating: 1,
  employee_count: 0,
  has_active_ad_spend: false,
  has_customer_support_process: false,
  has_existing_automations: false,
  data_confidence: 0.8,
  completeness: 0.85,
};

/** A real, operating business — the watching archetype. */
const OPERATING: ModeDecisionInputs = {
  stage: "operating",
  has_revenue: true,
  monthly_order_count: 60,
  months_operating: 24,
  employee_count: 0,
  has_active_ad_spend: false,
  has_customer_support_process: false,
  has_existing_automations: true,
  data_confidence: 0.75,
  completeness: 0.9,
};

const ruled = (i: ModeDecisionInputs, spend: number | null = null): ModeRuling => {
  const r = decideMode(i, spend);
  if ("deferred" in r) throw new Error("unexpectedly deferred");
  return r;
};

describe("P1-45 — defer instead of guessing", () => {
  it("below 0.5 completeness there is NO decision, whatever the inputs say", () => {
    const r = decideMode({ ...IDEA_STAGE, completeness: 0.4 }, null);
    expect("deferred" in r).toBe(true);
  });
  it("at 0.5 and above, it decides", () => {
    const r = decideMode({ ...IDEA_STAGE, completeness: 0.5 }, null);
    expect("deferred" in r).toBe(false);
  });
});

describe("§9 — instant requires ALL of the floor", () => {
  it("the idea-stage archetype is instant", () => {
    const r = ruled(IDEA_STAGE);
    expect(r.mode).toBe("instant");
    expect(r.watch_weeks).toBeNull();
  });

  it("revenue with 10+ lifetime orders forces watching — a live shop is not a sandbox", () => {
    expect(ruled({ ...IDEA_STAGE, has_revenue: true, monthly_order_count: 10 }).mode).toBe(
      "watching",
    );
  });

  it("revenue under 10 orders is still instant — a single test sale changes nothing", () => {
    expect(ruled({ ...IDEA_STAGE, has_revenue: true, monthly_order_count: 3 }).mode).toBe(
      "instant",
    );
  });

  it("one employee forces watching — someone's job is in the blast radius", () => {
    expect(ruled({ ...IDEA_STAGE, employee_count: 1 }).mode).toBe("watching");
  });

  it("active ad spend forces watching — a change can waste a running budget", () => {
    expect(ruled({ ...IDEA_STAGE, has_active_ad_spend: true }).mode).toBe("watching");
  });

  it("an existing support process forces watching — customers depend on it", () => {
    expect(ruled({ ...IDEA_STAGE, has_customer_support_process: true }).mode).toBe("watching");
  });

  it("3+ months of operation forces watching — there is a rhythm to protect", () => {
    expect(ruled({ ...IDEA_STAGE, months_operating: 3 }).mode).toBe("watching");
  });

  it("revenue with unknown order count blocks instant — unknown is not 'few'", () => {
    expect(ruled({ ...IDEA_STAGE, has_revenue: true, monthly_order_count: null }).mode).toBe(
      "watching",
    );
  });
});

describe("§9 — watch length", () => {
  it("defaults to 6 weeks", () => {
    expect(ruled({ ...OPERATING, monthly_order_count: 60 }).watch_weeks).toBe(6);
  });

  it("employees present → 8 weeks", () => {
    expect(ruled({ ...OPERATING, employee_count: 2 }).watch_weeks).toBe(8);
  });

  it("ad spend above the threshold → 8; at or below stays 6", () => {
    expect(ruled(OPERATING, AD_SPEND_8W_MINOR + 1).watch_weeks).toBe(8);
    expect(ruled(OPERATING, AD_SPEND_8W_MINOR).watch_weeks).toBe(6);
  });

  it("more than 100 monthly orders → 8; exactly 100 stays 6", () => {
    expect(ruled({ ...OPERATING, monthly_order_count: 101 }).watch_weeks).toBe(8);
    expect(ruled({ ...OPERATING, monthly_order_count: 100 }).watch_weeks).toBe(6);
  });

  it("data confidence below 0.6 → 8 weeks — estimates deserve a longer look", () => {
    expect(ruled({ ...OPERATING, data_confidence: 0.55 }).watch_weeks).toBe(8);
  });

  it("operating-but-tiny with high confidence and no staff → the only 4-week path", () => {
    const tiny = ruled({
      ...OPERATING,
      monthly_order_count: 20,
      data_confidence: 0.85,
    });
    expect(tiny.watch_weeks).toBe(4);
  });

  it("the same tiny business with an UNKNOWN order count stays at 6 — unknown is not 'tiny'", () => {
    const r = ruled({ ...OPERATING, monthly_order_count: null, data_confidence: 0.85 });
    expect(r.watch_weeks).toBe(6);
  });

  it("the same tiny business with mediocre confidence stays at 6", () => {
    const r = ruled({ ...OPERATING, monthly_order_count: 20, data_confidence: 0.7 });
    expect(r.watch_weeks).toBe(6);
  });
});

describe("§9 — the audit trail", () => {
  it("every ruling carries owner-readable reasons naming the triggering inputs", () => {
    const r = ruled({ ...OPERATING, employee_count: 2, monthly_order_count: 120 });
    expect(r.reasons.length).toBeGreaterThan(0);
    expect(r.reasons.join(" ")).toMatch(/people working|Employees/);
    expect(r.reasons.join(" ")).toMatch(/orders per month/);
  });
});
