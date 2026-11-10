// The currency table and FX — the multi-market spec §A.2, §A.3.
// "A rendered figure like 'HUF 35,412.50' is a bug. Test for it."

import { describe, expect, it } from "vitest";
import table from "../../specs/currencies-v1.json";
import {
  CURRENCY_ROWS,
  assertProcessorAmount,
  currencyRow,
  displayDecimals,
  formatMoney,
  roundForCurrency,
  roundPrice,
} from "./currency-table";
import { ISO_4217_CODES } from "./currencies";
import { ECB_SOURCE, FxError, convertFromStored, toEur } from "./fx";
import { minorUnitExponent, money } from "./money";

describe("§A.2 — the currency table", () => {
  it("has one row per active ISO 4217 code, with ISO's minor units", () => {
    expect(CURRENCY_ROWS.map((r) => r.code).sort()).toEqual([...ISO_4217_CODES].sort());
    for (const r of CURRENCY_ROWS) expect(r.minor_units, r.code).toBe(minorUnitExponent(r.code));
    expect((table as { rows: unknown[] }).rows).toHaveLength(ISO_4217_CODES.length);
  });

  it("HUF: two ISO digits, but whole forints — rounded, displayed and billed", () => {
    const huf = currencyRow("HUF");
    expect(huf.minor_units).toBe(2);
    expect(huf.rounding_increment_minor).toBe(100);
    expect(displayDecimals("HUF")).toBe(0);
    expect(huf.processor_amount_divisor_minor).toBe(100);
    expect(displayDecimals("EUR")).toBe(2);
    expect(displayDecimals("JPY")).toBe(0);
    expect(displayDecimals("KWD")).toBe(3);
  });

  it("never renders fillér: 35 412,50 Ft is a bug", () => {
    const shown = formatMoney(money(3_541_250, "HUF"));
    expect(shown).toBe("35 413 Ft");
    expect(shown).not.toMatch(/[.,]\d{2}\b/);
    expect(formatMoney(money(-499_000, "HUF"))).toBe("−4 990 Ft");
    expect(formatMoney(money(0, "HUF"))).toBe("0 Ft");
  });

  it("formats from the table — EUR, JPY, KWD — with no hard-coded 2", () => {
    expect(formatMoney(money(123_456, "EUR"))).toBe("€1,234.56");
    expect(formatMoney(money(1_200, "JPY"))).toBe("¥1,200");
    expect(formatMoney(money(1_234_567, "KWD"))).toBe("KWD1,234.567");
    expect(formatMoney(money(5, "EUR"))).toBe("€0.05");
  });

  it("rounds half away from zero to the currency's step, and prices to theirs", () => {
    expect(roundForCurrency(3_541_250, "HUF")).toBe(3_541_300);
    expect(roundForCurrency(3_541_249, "HUF")).toBe(3_541_200);
    expect(roundForCurrency(-150, "HUF")).toBe(-200);
    expect(roundForCurrency(1_234, "EUR")).toBe(1_234);
    expect(roundPrice(3_498_000, "HUF")).toBe(3_500_000); // 34 980 → 35 000 Ft
    expect(roundPrice(1_152_000, "HUF")).toBe(1_150_000); // 11 520 → 11 500 Ft
  });

  it("asserts Stripe's HUF rule at the billing boundary", () => {
    expect(() => assertProcessorAmount(money(1_150_000, "HUF"))).not.toThrow();
    expect(() => assertProcessorAmount(money(1_150_050, "HUF"))).toThrow(/divisible by 100/);
    expect(() => assertProcessorAmount(money(4_999, "EUR"))).not.toThrow();
  });
});

describe("§A.3 — FX from stored rates, exact", () => {
  const rate = { currency: "HUF", date: "2026-11-09", per_eur: "391.48", source: ECB_SOURCE };

  it("converts with integers only, carrying the rate, date and source", () => {
    const eur = toEur(money(3_500_000, "HUF"), rate); // 35 000 Ft ÷ 391.48 = €89.4043…
    expect(eur).toEqual({
      amount_minor: 8_940,
      currency: "EUR",
      fx_rate_to_eur: "391.48",
      fx_rate_date: "2026-11-09",
      fx_source: ECB_SOURCE,
    });
  });

  it("a stored conversion reproduces exactly from its stored rate and date", () => {
    const original = money(123_456_700, "HUF");
    const stored = toEur(original, rate);
    // Years later, at whatever today's rate is, the stored one still answers.
    expect(convertFromStored(original, stored)).toEqual(stored);
  });

  it("refuses a rate for another currency, EUR→EUR, or a rate that isn't a number", () => {
    expect(() => toEur(money(1, "PLN"), rate)).toThrow(FxError);
    expect(() => toEur(money(1, "EUR"), { ...rate, currency: "EUR" })).toThrow(
      /needs no conversion/,
    );
    expect(() => toEur(money(1, "HUF"), { ...rate, per_eur: "3.9e2" })).toThrow(FxError);
    expect(() => toEur(money(1, "HUF"), { ...rate, per_eur: "0" })).toThrow(FxError);
  });

  it("is exact where floats drift: 0.1 + 0.2 territory", () => {
    const r = { currency: "USD", date: "2026-11-09", per_eur: "1.0786", source: ECB_SOURCE };
    // 10 723.37 USD ÷ 1.0786 = 9 941.9340… EUR
    expect(toEur(money(1_072_337, "USD"), r).amount_minor).toBe(994_193);
  });
});
