import { describe, expect, it } from "vitest";
import type { ModeDecision } from "./mode-view";
import { humanise, overrideLine, plainReasons, title, watchDay } from "./mode-view";

const watching: ModeDecision = {
  mode: "watching",
  watch_weeks: 4,
  decided_at: "2026-09-29 10:00:00+00",
  reasons: ["~120 orders per month"],
  reasoning: "stored",
  review_at: "2026-10-27 10:00:00+00",
  owner_override: null,
};

describe("mode view", () => {
  it("says how Lex starts here, in weeks", () => {
    expect(title(watching)).toBe("Lex watches for 4 weeks before suggesting anything");
    expect(title({ ...watching, watch_weeks: 1 })).toBe(
      "Lex watches for 1 week before suggesting anything",
    );
  });

  it("an instant decision suggests from the first read", () => {
    expect(title({ ...watching, mode: "instant", watch_weeks: null })).toBe(
      "Lex suggests changes from the first read",
    );
    expect(watchDay({ ...watching, mode: "instant", watch_weeks: null }, Date.now())).toBeNull();
  });

  it("counts the watch day the way the menu does, clamped to the window", () => {
    const now = Date.parse("2026-10-17T10:00:00Z");
    expect(watchDay(watching, now)).toEqual({ day: 18, of: 28 });
    expect(watchDay(watching, Date.parse("2026-12-01T00:00:00Z"))).toEqual({ day: 28, of: 28 });
    expect(watchDay(watching, Date.parse("2026-09-01T00:00:00Z"))).toEqual({ day: 1, of: 28 });
  });

  it("says who chose the length when the owner changed it, and nothing otherwise", () => {
    expect(overrideLine(watching)).toBeNull();
    const o = { from_weeks: 8, to_weeks: 4, at: "2026-10-03 09:00:00+00" };
    expect(overrideLine({ ...watching, owner_override: { kind: "shorten", ...o } })).toBe(
      "Lex suggested 8 weeks; you chose 4 weeks.",
    );
    expect(
      overrideLine({
        ...watching,
        owner_override: { kind: "extend", ...o, to_weeks: 8, from_weeks: 4 },
      }),
    ).toBe("Lex suggested 4 weeks; you asked for 8 weeks.");
  });

  it("says each reason once, from the inputs the rule stored", () => {
    const d = {
      ...watching,
      reasons: ["~672 orders per month", "Employees are present", "More than 100 orders per month"],
      inputs: {
        has_revenue: true,
        monthly_order_count: 672,
        employee_count: 1,
        has_active_ad_spend: true,
        has_customer_support_process: false,
        months_operating: 68,
      },
    };
    expect(plainReasons(d)).toEqual([
      { key: "orders", values: { count: 672 } },
      { key: "staff", values: { count: 1 } },
      { key: "ads" },
      { key: "tradingOver", values: { count: 5 } },
    ]);
    expect(plainReasons({ ...d, inputs: { ...d.inputs, months_operating: 24 } })?.at(-1)).toEqual({
      key: "tradingYears",
      values: { count: 2 },
    });
    expect(plainReasons({ ...d, inputs: { ...d.inputs, months_operating: 5 } })?.at(-1)).toEqual({
      key: "tradingMonths",
      values: { count: 5 },
    });
    // Stored without inputs: the caller shows the stored reasons instead.
    expect(plainReasons(watching)).toBeNull();
  });

  it("says why an instant start is safe", () => {
    const d = {
      ...watching,
      mode: "instant" as const,
      watch_weeks: null,
      inputs: { has_revenue: false, months_operating: 1 },
    };
    expect(plainReasons(d)?.map((r) => r.key)).toEqual(["noRevenue", "noStaff", "noAds", "new"]);
  });

  it("reads long month counts as years", () => {
    expect(humanise("Operating for 40 months")).toBe("Operating for 3 years");
    expect(humanise("Operating for 5 months")).toBe("Operating for 5 months");
  });
});
