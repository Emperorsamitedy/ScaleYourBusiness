// Money arrives from store platforms as decimal strings. These tests pin the
// conversion to integer minor units: exact, sign-preserving, currency-aware,
// and refusing rather than rounding (rule 1).

import { describe, expect, it } from "vitest";
import { DecimalError, decimalToMinor } from "./decimal";

describe("decimalToMinor", () => {
  it("converts two-decimal currencies exactly", () => {
    expect(decimalToMinor("12.50", "EUR")).toBe(1250);
    expect(decimalToMinor("12.5", "eur")).toBe(1250);
    expect(decimalToMinor("12", "USD")).toBe(1200);
    expect(decimalToMinor("0.10", "USD")).toBe(10);
    expect(decimalToMinor("1234567.89", "HUF")).toBe(123_456_789);
  });

  it("keeps the sign, which is how refunds arrive", () => {
    expect(decimalToMinor("-5.00", "EUR")).toBe(-500);
    expect(decimalToMinor("-0.00", "EUR")).toBe(0);
  });

  it("respects zero- and three-decimal currencies", () => {
    expect(decimalToMinor("1200", "JPY")).toBe(1200);
    expect(decimalToMinor("1200.0", "JPY")).toBe(1200);
    expect(decimalToMinor("1.234", "KWD")).toBe(1234);
  });

  it("accepts trailing zeros beyond the exponent, and refuses real extra precision", () => {
    expect(decimalToMinor("12.5000", "EUR")).toBe(1250);
    expect(() => decimalToMinor("12.505", "EUR")).toThrow(DecimalError);
    expect(() => decimalToMinor("1200.5", "JPY")).toThrow(DecimalError);
  });

  it("refuses anything that is not a plain decimal", () => {
    for (const bad of ["", "12,50", "1e3", "12.", ".5", "abc", "$12.00"]) {
      expect(() => decimalToMinor(bad, "EUR"), bad).toThrow(DecimalError);
    }
  });
});
