// Reading amounts people write — review 2026-10-23, #4 and #13. One exact
// path (readAmount → digitsToMinor) for every import and chat amount: no
// float, no rounding, a lone "d.ddd" ambiguous until a style settles it.

import { describe, expect, it } from "vitest";
import { ISO_4217_CODES, isIsoCurrency } from "./currencies";
import {
  InvalidMoneyError,
  digitsToMinor,
  money,
  minorUnitExponent,
  parseAmountMinor,
  parseMoneyMinor,
  readAmount,
  settleDecimalStyle,
} from "./money";

const minor = (
  raw: string,
  currency: string,
  style: "dot_decimal" | "comma_decimal" | null = null,
) => parseAmountMinor(raw, currency, style);

describe("unambiguous amounts read exactly", () => {
  it("EUR (exponent 2): both styles, a comma decimal, space grouping", () => {
    expect(minor("1.234,56", "EUR")).toEqual({ ok: true, minor: 123_456, proves: "comma_decimal" });
    expect(minor("1,234.56", "EUR")).toEqual({ ok: true, minor: 123_456, proves: "dot_decimal" });
    expect(minor("12,50 €", "EUR")).toEqual({ ok: true, minor: 1_250, proves: "comma_decimal" });
    expect(minor("€12.5", "EUR")).toEqual({ ok: true, minor: 1_250, proves: "dot_decimal" });
    expect(minor("1 200", "EUR")).toEqual({ ok: true, minor: 120_000, proves: null });
    expect(minor("1 234,5", "EUR")).toEqual({ ok: true, minor: 123_450, proves: "comma_decimal" });
    expect(minor("1.234.567", "EUR")).toEqual({
      ok: true,
      minor: 123_456_700,
      proves: "comma_decimal",
    });
    expect(minor("0.500", "EUR")).toEqual({ ok: true, minor: 50, proves: "dot_decimal" });
    expect(minor("-5.00", "EUR")).toEqual({ ok: true, minor: -500, proves: "dot_decimal" });
  });

  it("HUF (exponent 2 in this codebase — amount_minor is fillér, data-model §3.3)", () => {
    expect(minorUnitExponent("HUF")).toBe(2);
    expect(minor("12 000 Ft", "HUF")).toEqual({ ok: true, minor: 1_200_000, proves: null });
    expect(minor("12.000", "HUF", "comma_decimal")).toEqual({
      ok: true,
      minor: 1_200_000,
      proves: null,
    });
    expect(minor("1.234.567,00", "HUF")).toMatchObject({ ok: true, minor: 123_456_700 });
  });

  it("JPY (exponent 0): a thousands dot reads, a decimal yen is refused, never rounded", () => {
    expect(minor("1.200", "JPY", "comma_decimal")).toMatchObject({ ok: true, minor: 1_200 });
    expect(minor("1.200", "JPY", "dot_decimal")).toEqual({ ok: false, reason: "too_precise" });
    expect(minor("1.5", "JPY")).toEqual({ ok: false, reason: "too_precise" });
    expect(minor("1.0", "JPY")).toMatchObject({ ok: true, minor: 1 });
  });

  it("KWD (exponent 3): three decimals read, a fourth is refused", () => {
    expect(minor("1.234,567", "KWD")).toMatchObject({ ok: true, minor: 1_234_567 });
    expect(minor("12.5", "KWD")).toMatchObject({ ok: true, minor: 12_500 });
    expect(minor("1.2345", "KWD")).toEqual({ ok: false, reason: "too_precise" });
  });

  it("refuses more precision than the currency allows, and never floats", () => {
    expect(minor("1.234", "EUR", "dot_decimal")).toEqual({ ok: false, reason: "too_precise" });
    expect(minor("12,505", "EUR", "comma_decimal")).toEqual({ ok: false, reason: "too_precise" });
    // The float path read 0.1 + 0.2 style values wrongly; the digit path can't.
    expect(minor("1234567890123.45", "EUR")).toMatchObject({
      ok: true,
      minor: 123_456_789_012_345,
    });
    expect(minor("99999999999999999", "EUR")).toEqual({ ok: false, reason: "too_large" });
    expect(digitsToMinor(false, "12", "500", "EUR")).toEqual({ ok: true, minor: 1_250 });
  });

  it("refuses what isn't an amount", () => {
    for (const raw of ["", "abc", "1.2.3", "1,23.4", "12-3", "1 23", "--5"]) {
      expect(readAmount(raw).ok).toBe(false);
    }
  });
});

describe("a lone separator before exactly three digits is ambiguous", () => {
  it("1.200, 1,200 and 12.000 ask; a style settles them each way", () => {
    for (const raw of ["1.200", "1,200", "12.000", "120,000"]) {
      expect(minor(raw, "EUR")).toEqual({ ok: false, reason: "ambiguous" });
      expect(parseMoneyMinor(raw, "EUR")).toBeNull();
    }
    expect(minor("1.200", "EUR", "comma_decimal")).toMatchObject({ ok: true, minor: 120_000 });
    expect(minor("1.200", "EUR", "dot_decimal")).toMatchObject({ ok: true, minor: 120 });
    expect(minor("1,200", "EUR", "dot_decimal")).toMatchObject({ ok: true, minor: 120_000 });
    expect(minor("1,200", "EUR", "comma_decimal")).toMatchObject({ ok: true, minor: 120 });
  });

  it("a value that only reads the other way contradicts a stated style", () => {
    expect(minor("12,50", "EUR", "dot_decimal")).toEqual({ ok: false, reason: "style_conflict" });
    expect(minor("1,234.56", "EUR", "comma_decimal")).toEqual({
      ok: false,
      reason: "style_conflict",
    });
  });

  it("a column settles its style like a file's dates, and refuses one that proves both", () => {
    expect(settleDecimalStyle(["1.200", "12,50"], null)).toEqual({
      ok: true,
      style: "comma_decimal",
      proven: true,
    });
    expect(settleDecimalStyle(["1.200", "2.400"], null)).toEqual({
      ok: false,
      reason: "ambiguous",
    });
    expect(settleDecimalStyle(["1.200"], "dot_decimal")).toEqual({
      ok: true,
      style: "dot_decimal",
      proven: false,
    });
    expect(settleDecimalStyle(["1.234,56", "1,234.56"], null)).toEqual({
      ok: false,
      reason: "both",
    });
    expect(settleDecimalStyle(["12,50"], "dot_decimal")).toEqual({
      ok: false,
      reason: "contradicts_stated",
    });
    expect(settleDecimalStyle(["12", "1 200"], null)).toEqual({
      ok: true,
      style: null,
      proven: false,
    });
  });
});

describe("currencies are ISO 4217 codes only (#13)", () => {
  it("knows the real codes and refuses three capital letters that aren't one", () => {
    for (const c of ["EUR", "HUF", "USD", "JPY", "KWD", "GBP"]) expect(isIsoCurrency(c)).toBe(true);
    for (const c of ["VAT", "INC", "TAX", "eur", "EURO"]) expect(isIsoCurrency(c)).toBe(false);
    expect(new Set(ISO_4217_CODES).size).toBe(ISO_4217_CODES.length);
  });

  it("money() refuses a currency called VAT", () => {
    expect(() => money(100, "VAT")).toThrow(InvalidMoneyError);
    expect(money(100, "EUR")).toEqual({ amount_minor: 100, currency: "EUR" });
  });
});
