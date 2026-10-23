import { describe, expect, it } from "vitest";
import type { DeltaInput } from "./materiality";
import {
  MATERIALITY,
  countFloor,
  isPercentField,
  materialityOf,
  moneyFloorMinor,
  quietLine,
  splitByMateriality,
} from "./materiality";

const money = (amount_minor: number, currency = "EUR") => ({ amount_minor, currency });

/** measured − stated, as lib/connectors/stated-vs-measured.ts measuredDelta() builds it. */
function measuredDelta(stated: unknown, measured: unknown): DeltaInput["delta"] {
  const round1 = (n: number) => Math.round(n * 10) / 10;
  if (typeof stated === "number" && typeof measured === "number") {
    return {
      amount: measured - stated,
      currency: null,
      pct: stated === 0 ? null : round1(((measured - stated) / stated) * 100),
    };
  }
  const s = stated as { amount_minor: number; currency: string };
  const m = measured as { amount_minor: number; currency: string };
  if (s.currency !== m.currency) return null;
  const amount = m.amount_minor - s.amount_minor;
  return { amount, currency: m.currency, pct: round1((amount / s.amount_minor) * 100) };
}

/** A pair as statedVsMeasured() builds it. */
function pair(field_key: string, stated: unknown, measured: unknown): DeltaInput {
  return {
    field_key,
    stated: { value: stated },
    measured: { value: measured },
    delta: stated === null ? null : measuredDelta(stated, measured),
  };
}
const revenue = (s: number, m: number, c = "EUR") =>
  pair("revenue.monthly_revenue", money(s, c), money(m, c));

describe("the thresholds, pinned", () => {
  it("is 15% relative AND a floor per unit", () => {
    expect(MATERIALITY.min_relative_pct).toBe(15);
    expect(countFloor("revenue.order_count_monthly")).toBe(5);
    expect(countFloor("offers.0b6f.volume_period")).toBe(5);
    expect(countFloor("presence.monthly_sessions")).toBe(100);
    expect(countFloor("channels.0b6f.monthly_sessions")).toBe(100);
  });

  it("states money floors in minor units by each currency's exponent (rule 1)", () => {
    expect(moneyFloorMinor("EUR")).toBe(5_000); // 50.00
    expect(moneyFloorMinor("HUF")).toBe(2_000_000); // 20 000.00 — HUF is exponent 2
    expect(moneyFloorMinor("JPY")).toBe(7_500); // exponent 0
    expect(moneyFloorMinor("KWD")).toBe(50_000); // unlisted, exponent 3: 50.000
    for (const c of ["EUR", "HUF", "JPY", "KWD", "XYZ"]) {
      expect(Number.isSafeInteger(moneyFloorMinor(c))).toBe(true);
    }
  });
});

describe("percent fields — their own floor in percentage points (review 2026-10-23, #23)", () => {
  const rate = (s: number, m: number) => pair("revenue.repeat_customer_rate", s, m);

  it("pins the floor at 2 points and knows a percent field by its key", () => {
    expect(MATERIALITY.percent_floor_pp).toBe(2);
    expect(isPercentField("revenue.repeat_customer_rate")).toBe(true);
    expect(isPercentField("service.no_show_rate_28d")).toBe(true);
    expect(isPercentField("revenue.gross_margin")).toBe(true);
    expect(isPercentField("revenue.order_count_monthly")).toBe(false);
  });

  it("shows a 10 % → 14 % repeat rate as material (the count floor of 5 hid it)", () => {
    expect(materialityOf(rate(10, 14))).toEqual({ material: true, reason: "material" });
  });

  it("boundary both ways: exactly 2 points is material, 1.9 is below the floor", () => {
    expect(materialityOf(rate(10, 12)).material).toBe(true);
    expect(materialityOf(rate(10, 11.9))).toEqual({ material: false, reason: "below_floor" });
  });

  it("still needs the relative test: 50 % → 57 % is within 15 %", () => {
    expect(materialityOf(rate(50, 57))).toEqual({ material: false, reason: "within_relative" });
  });
});

describe("materialityOf — boundaries, both ways", () => {
  it("relative: exactly 15% is material, just under is not", () => {
    // €10 000 stated: 15% is €1 500, well past the €50 floor.
    expect(materialityOf(revenue(1_000_000, 1_150_000)).material).toBe(true);
    expect(materialityOf(revenue(1_000_000, 850_000)).material).toBe(true);
    expect(materialityOf(revenue(1_000_000, 1_149_999))).toEqual({
      material: false,
      reason: "within_relative",
    });
    expect(materialityOf(revenue(1_000_000, 850_001)).material).toBe(false);
  });

  it("uses the raw figures, not the rounded percent", () => {
    // 14.96% rounds to 15.0 in the delta's pct, but is under 15%.
    const r = revenue(1_000_000, 1_149_600);
    expect(r.delta?.pct).toBe(15);
    expect(materialityOf(r).material).toBe(false);
  });

  it("absolute money: at the floor is material, one minor unit under is not", () => {
    // €200 stated, so €50 is 25% — the floor is what decides.
    expect(materialityOf(revenue(20_000, 25_000)).material).toBe(true);
    expect(materialityOf(revenue(20_000, 24_999))).toEqual({
      material: false,
      reason: "below_floor",
    });
  });

  it("applies the floor in the delta's own currency", () => {
    // 10 000 HUF off on 40 000 HUF is 25%, but under the 20 000 HUF floor.
    expect(materialityOf(revenue(4_000_000, 5_000_000, "HUF")).material).toBe(false);
    expect(materialityOf(revenue(4_000_000, 6_000_000, "HUF")).material).toBe(true);
    // ¥7 500 is the floor at exponent 0.
    expect(materialityOf(revenue(20_000, 27_500, "JPY")).material).toBe(true);
    expect(materialityOf(revenue(20_000, 27_499, "JPY")).material).toBe(false);
  });

  it("absolute count: 5 orders is material, 4 is not", () => {
    expect(materialityOf(pair("revenue.order_count_monthly", 20, 25)).material).toBe(true);
    expect(materialityOf(pair("revenue.order_count_monthly", 20, 24)).material).toBe(false);
    expect(materialityOf(pair("presence.monthly_sessions", 400, 500)).material).toBe(true);
    expect(materialityOf(pair("presence.monthly_sessions", 400, 499)).material).toBe(false);
  });

  it("never calls an unknown estimate or two currencies a match", () => {
    expect(materialityOf(pair("revenue.monthly_revenue", null, money(500_000)))).toEqual({
      material: true,
      reason: "no_estimate",
    });
    expect(
      materialityOf(pair("revenue.monthly_revenue", money(500_000, "EUR"), money(500_000, "USD"))),
    ).toEqual({ material: true, reason: "not_comparable" });
  });

  it("treats a change from a stated zero on its floor alone", () => {
    expect(materialityOf(pair("revenue.order_count_monthly", 0, 5)).material).toBe(true);
    expect(materialityOf(pair("revenue.order_count_monthly", 0, 4)).material).toBe(false);
  });
});

describe("the split and the quiet line — nothing is dropped", () => {
  const rows = [
    revenue(1_000_000, 1_400_000), // 40%: material
    revenue(1_000_000, 1_050_000), // 5%: quiet, within
    pair("revenue.order_count_monthly", 20, 24), // 20%, 4 orders: quiet, small amount
  ];

  it("keeps every pair, material in order, the rest quiet with why", () => {
    const s = splitByMateriality(rows);
    expect(s.material).toEqual([rows[0]]);
    expect(s.quiet.map((q) => [q.row, q.reason])).toEqual([
      [rows[1], "within_relative"],
      [rows[2], "below_floor"],
    ]);
    expect(s.material.length + s.quiet.length).toBe(rows.length);
  });

  it("says how many matched, and how", () => {
    const s = splitByMateriality(rows);
    expect(quietLine(s.quiet, rows.length)).toBe(
      "2 of the 3 figures you gave me matched your accounts within 15% or by a small amount.",
    );
    expect(quietLine([{ reason: "within_relative" }], 4)).toBe(
      "1 of the 4 figures you gave me matched your accounts within 15%.",
    );
    expect(quietLine([{ reason: "within_relative" }, { reason: "within_relative" }], 2)).toBe(
      "Both figures you gave me matched your accounts within 15%.",
    );
    expect(
      quietLine(
        [
          { reason: "within_relative" },
          { reason: "within_relative" },
          { reason: "within_relative" },
        ],
        3,
      ),
    ).toBe("All 3 figures you gave me matched your accounts within 15%.");
    expect(quietLine([{ reason: "within_relative" }], 1)).toBe(
      "The figure you gave me matched your accounts within 15%.",
    );
    expect(quietLine([], 3)).toBeNull();
  });
});
