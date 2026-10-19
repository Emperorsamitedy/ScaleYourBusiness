// P3-22b/c — the pure half of the spend guardrails and Meta's budget units.
// One guard, run at generation and again in the executor; each rule has a
// passing and a failing case, and the currency offset has a test per class.

import { describe, expect, it } from "vitest";
import {
  MAX_CHANGE_SHARE,
  META_CURRENCY_OFFSET,
  META_MIN_DAILY_BUDGET_MINOR,
  UnknownMetaCurrencyError,
  dailyBudgetFloor,
  fromMetaBudget,
  spendGuard,
  toMetaBudget,
} from "./guard";

describe("P3-22b — Meta's currency offset (the Currencies page, read 2026-10-19)", () => {
  it("lists exactly the eleven offset-1 currencies Meta's page lists", () => {
    const one = Object.entries(META_CURRENCY_OFFSET)
      .filter(([, o]) => o === 1)
      .map(([c]) => c)
      .sort();
    expect(one).toEqual([
      "CLP",
      "COP",
      "CRC",
      "HUF",
      "IDR",
      "ISK",
      "JPY",
      "KRW",
      "PYG",
      "TWD",
      "VND",
    ]);
    expect(META_CURRENCY_OFFSET["EUR"]).toBe(100);
    expect(META_CURRENCY_OFFSET["USD"]).toBe(100);
  });

  it("offset 1 with a two-decimal ISO currency (HUF): fillér → whole forints, rounded down", () => {
    expect(toMetaBudget(150_000, "HUF")).toEqual({ meta_value: 1_500, sent_minor: 150_000 });
    expect(toMetaBudget(150_099, "HUF")).toEqual({ meta_value: 1_500, sent_minor: 150_000 });
    expect(fromMetaBudget(1_500, "HUF")).toBe(150_000);
  });

  it("offset 1 with a zero-decimal ISO currency (JPY, KRW): unchanged", () => {
    expect(toMetaBudget(5_000, "JPY")).toEqual({ meta_value: 5_000, sent_minor: 5_000 });
    expect(fromMetaBudget(5_000, "KRW")).toBe(5_000);
  });

  it("offset 100 with a two-decimal currency (EUR, USD): cents stay cents", () => {
    expect(toMetaBudget(1_234, "EUR")).toEqual({ meta_value: 1_234, sent_minor: 1_234 });
    expect(fromMetaBudget(1_234, "usd")).toBe(1_234);
  });

  it("offset 100 with a three-decimal currency (BHD, JOD): fils → Meta's hundredths, rounded down", () => {
    expect(toMetaBudget(1_239, "BHD")).toEqual({ meta_value: 123, sent_minor: 1_230 });
    expect(fromMetaBudget(123, "JOD")).toBe(1_230);
  });

  it("a currency Meta doesn't list is refused, never guessed", () => {
    expect(() => toMetaBudget(1_000, "KWD")).toThrow(UnknownMetaCurrencyError);
    expect(() => fromMetaBudget(1_000, "XAF")).toThrow(/won't send a budget in it/);
    expect(() => toMetaBudget(1.5, "EUR")).toThrow(RangeError);
  });
});

describe("P3-22c — the floor", () => {
  it("the table's figure, or the account's own minimum when higher; neither known is null", () => {
    expect(dailyBudgetFloor("EUR", null)).toBe(META_MIN_DAILY_BUDGET_MINOR["EUR"]);
    expect(dailyBudgetFloor("EUR", 900)).toBe(900);
    expect(dailyBudgetFloor("EUR", 50)).toBe(100);
    expect(dailyBudgetFloor("SEK", 2_000)).toBe(2_000);
    expect(dailyBudgetFloor("SEK", null)).toBeNull();
  });
});

describe("P3-22c — spendGuard, each rule both ways", () => {
  const base = { current_daily_minor: 1_000, currency: "EUR" };

  it("±50%: 50% passes, 51% and −51% are refused, naming the share", () => {
    expect(spendGuard({ ...base, proposed_daily_minor: 1_500 })).toBeNull();
    expect(spendGuard({ ...base, proposed_daily_minor: 500 })).toBeNull();
    expect(spendGuard({ ...base, proposed_daily_minor: 1_510 })).toBe(
      `a 51% change is beyond the ${MAX_CHANGE_SHARE * 100}% allowed in one approval`,
    );
    expect(spendGuard({ ...base, proposed_daily_minor: 490 })).toMatch(/-51% change/);
  });

  it("no baseline to bound against is refused", () => {
    expect(spendGuard({ ...base, current_daily_minor: 0, proposed_daily_minor: 100 })).toMatch(
      /zero or unknown/,
    );
  });

  it("the floor: at it passes, under it is refused, naming both figures", () => {
    expect(spendGuard({ ...base, proposed_daily_minor: 600, floor_minor: 600 })).toBeNull();
    expect(spendGuard({ ...base, proposed_daily_minor: 599, floor_minor: 600 })).toBe(
      "it would set the daily budget to €5.99, under Meta's minimum of €6.00 a day",
    );
  });

  it("the ceiling: the whole account's month, plus the change, against the owner's figure", () => {
    const ceiling = (amount_minor: number) => ({ amount_minor, currency: "EUR" });
    // (€50 + €2) × 30 = €1,560.
    const args = { ...base, proposed_daily_minor: 1_200, account_daily_minor: 5_000 };
    expect(spendGuard({ ...args, monthly_ceiling: ceiling(156_000) })).toBeNull();
    expect(spendGuard({ ...args, monthly_ceiling: ceiling(155_999) })).toBe(
      "it would take monthly ad spend to about €1,560.00, over your stated ceiling of €1,559.99",
    );
    // A decrease never breaches a ceiling.
    expect(
      spendGuard({ ...args, proposed_daily_minor: 800, monthly_ceiling: ceiling(1) }),
    ).toBeNull();
  });

  it("a ceiling in another currency is never converted (rule 1)", () => {
    expect(
      spendGuard({
        ...base,
        proposed_daily_minor: 1_100,
        monthly_ceiling: { amount_minor: 10_000_000, currency: "HUF" },
      }),
    ).toMatch(/ceiling is in HUF and this campaign spends in EUR/);
  });
});
