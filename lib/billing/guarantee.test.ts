// The guarantee in the billing currency — the multi-market spec §A.5:
// "Add a test that fails if any EUR conversion is touched during a HUF
// guarantee evaluation."

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

// Any conversion during an evaluation fails the test outright.
vi.mock("../core/fx", () => {
  const touched = () => {
    throw new Error("an FX conversion was touched during a guarantee evaluation");
  };
  return { toEur: touched, convertFromStored: touched, ECB_SOURCE: "x", FxError: Error };
});
vi.mock("../fx/ecb", () => {
  const touched = () => {
    throw new Error("an FX rate was read during a guarantee evaluation");
  };
  return {
    rateOn: touched,
    fetchAndStoreEcb: touched,
    storeRates: touched,
    parseEcbDaily: touched,
  };
});

const { GUARANTEE, evaluateGuarantee } = await import("./guarantee");
const { money } = await import("../core/money");

const entry = (
  net: number,
  over: Partial<Parameters<typeof evaluateGuarantee>[0]["entries"][number]> = {},
) => ({
  plan_id: crypto.randomUUID(),
  verdict: net >= 0 ? ("verified_gain" as const) : ("loss" as const),
  net_minor: net,
  currency: "HUF",
  grade: "C",
  shadow: false,
  ...over,
});

// Act tier at 35 000 Ft a month: 105 000 Ft a quarter.
const FEE = money(10_500_000, "HUF");

describe("§8.4 in the billing currency (§A.5)", () => {
  it("a HUF subscription with HUF gains evaluates without touching any conversion", () => {
    const entries = Array.from({ length: 8 }, () => entry(5_000_000)); // 8 × 50 000 Ft
    const r = evaluateGuarantee({ tier: "autonomous", fee: FEE, entries });
    expect(r).toMatchObject({
      applies: true,
      outcome: "met",
      verified: money(40_000_000, "HUF"),
      ratio_bp: 38_095, // 3.8×
      credit: null,
      other_currency_entries: 0,
    });
  });

  it("below 3× the fee, the next quarter is credited — in forints", () => {
    const entries = Array.from({ length: 8 }, () => entry(3_000_000));
    const r = evaluateGuarantee({ tier: "autonomous", fee: FEE, entries });
    expect(r).toMatchObject({ outcome: "credit", credit: FEE });
  });

  it("exactly 3× meets it — compared in integers, not floats", () => {
    const entries = [
      ...Array.from({ length: 7 }, () => entry(0, { verdict: "no_effect" })),
      entry(31_500_000),
    ];
    expect(evaluateGuarantee({ tier: "autonomous", fee: FEE, entries })).toMatchObject({
      outcome: "met",
    });
  });

  it("losses count against it; D grades, inconclusive and shadow plans don't count", () => {
    const entries = [
      entry(40_000_000),
      entry(-20_000_000),
      entry(90_000_000, { grade: "D" }),
      entry(90_000_000, { verdict: "inconclusive" }),
      entry(90_000_000, { shadow: true }),
      ...Array.from({ length: 5 }, () => entry(0, { verdict: "no_effect" })),
    ];
    const r = evaluateGuarantee({ tier: "autonomous", fee: FEE, entries });
    expect(r).toMatchObject({
      verified: money(20_000_000, "HUF"),
      closed_plans: 9,
      outcome: "credit",
    });
  });

  it("an entry in another currency is left out and counted — never converted", () => {
    const entries = [
      ...Array.from({ length: 8 }, () => entry(5_000_000)),
      entry(1_000_000, { currency: "EUR" }),
    ];
    const r = evaluateGuarantee({ tier: "autonomous", fee: FEE, entries });
    expect(r).toMatchObject({ verified: money(40_000_000, "HUF"), other_currency_entries: 1 });
  });

  it("fewer than 8 closed plans rolls forward instead of paying out", () => {
    const entries = Array.from({ length: 7 }, () => entry(0, { verdict: "no_effect" }));
    expect(evaluateGuarantee({ tier: "autonomous", fee: FEE, entries })).toMatchObject({
      outcome: "rolled_forward",
      credit: null,
    });
  });

  it("only the Autonomous tier carries it, and says so", () => {
    expect(evaluateGuarantee({ tier: "act", fee: FEE, entries: [] })).toEqual({
      applies: false,
      reason: "not_autonomous",
    });
    expect(GUARANTEE.threshold_bp).toBe(30_000);
  });

  it("the module imports no conversion at all", () => {
    const source = readFileSync(path.resolve(__dirname, "guarantee.ts"), "utf8");
    expect(source).not.toMatch(/from\s+["'][^"']*(core\/fx|fx\/ecb)["']/);
    expect(source).not.toMatch(/reporting_eur/);
  });
});
