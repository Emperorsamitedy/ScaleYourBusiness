import { describe, expect, it } from "vitest";
import { dateRange, InvalidDateRangeError, isOngoing } from "./date-range";
import { enumCode, enumValue, InvalidEnumValueError, isOther, OTHER_CODE } from "./enum-value";
import { InvalidISODateError, isoDate } from "./iso";
import { InvalidQuantityError, quantity } from "./quantity";

describe("isoDate", () => {
  it("accepts a real calendar date", () => {
    expect(isoDate("2026-08-20")).toBe("2026-08-20");
  });

  it("accepts a leap day in a leap year", () => {
    expect(isoDate("2024-02-29")).toBe("2024-02-29");
  });

  it("rejects a malformed shape", () => {
    expect(() => isoDate("20/08/2026")).toThrow(InvalidISODateError);
    expect(() => isoDate("2026-8-20")).toThrow(InvalidISODateError);
    expect(() => isoDate("")).toThrow(InvalidISODateError);
  });

  it("rejects dates that don't exist on the calendar", () => {
    expect(() => isoDate("2026-02-30")).toThrow(InvalidISODateError);
    expect(() => isoDate("2026-13-01")).toThrow(InvalidISODateError);
    expect(() => isoDate("2025-02-29")).toThrow(InvalidISODateError); // not a leap year
  });
});

describe("quantity", () => {
  it("accepts an amount with a unit, including fractional amounts", () => {
    expect(quantity(2.5, "kg")).toEqual({ amount: 2.5, unit: "kg" });
    expect(quantity(40, "hours")).toEqual({ amount: 40, unit: "hours" });
  });

  it("rejects a non-finite amount", () => {
    expect(() => quantity(Number.NaN, "pcs")).toThrow(InvalidQuantityError);
    expect(() => quantity(Number.POSITIVE_INFINITY, "pcs")).toThrow(InvalidQuantityError);
  });

  it("rejects an empty or whitespace unit — a bare number is not a quantity", () => {
    expect(() => quantity(5, "")).toThrow(InvalidQuantityError);
    expect(() => quantity(5, "   ")).toThrow(InvalidQuantityError);
  });
});

describe("dateRange", () => {
  it("accepts an ordered closed range", () => {
    const range = dateRange(isoDate("2026-01-01"), isoDate("2026-06-30"));
    expect(isOngoing(range)).toBe(false);
  });

  it("accepts a same-day range — a one-day campaign is legal", () => {
    expect(() => dateRange(isoDate("2026-03-15"), isoDate("2026-03-15"))).not.toThrow();
  });

  it("treats to: null as ongoing", () => {
    expect(isOngoing(dateRange(isoDate("2024-05-01"), null))).toBe(true);
  });

  it("rejects a range that ends before it starts", () => {
    expect(() => dateRange(isoDate("2026-06-30"), isoDate("2026-01-01"))).toThrow(
      InvalidDateRangeError,
    );
  });
});

describe("enumValue", () => {
  it("accepts a vocabulary code without label_raw", () => {
    expect(enumValue("physical_products")).toEqual({ code: "physical_products" });
  });

  it('accepts "other" with the owner\'s exact wording preserved', () => {
    const value = enumValue(OTHER_CODE, "kézműves szörp");
    expect(value).toEqual({ code: "other", label_raw: "kézműves szörp" });
    expect(isOther(value)).toBe(true);
  });

  it('accepts "other" without label_raw — the wording is desired, not forced', () => {
    expect(enumValue(OTHER_CODE)).toEqual({ code: "other" });
  });

  it("rejects an empty code", () => {
    expect(() => enumValue("")).toThrow(InvalidEnumValueError);
    expect(() => enumValue("   ")).toThrow(InvalidEnumValueError);
  });

  it("rejects label_raw on a real vocabulary code — it would shadow the vocabulary label", () => {
    expect(() => enumValue("services", "my services")).toThrow(InvalidEnumValueError);
  });

  it("rejects an empty label_raw — it records nothing", () => {
    expect(() => enumValue(OTHER_CODE, "")).toThrow(InvalidEnumValueError);
    expect(() => enumValue(OTHER_CODE, "  ")).toThrow(InvalidEnumValueError);
  });
});

describe("enumCode", () => {
  it("reads the code from the intake's EnumValue and from a bare code string alike", () => {
    expect(enumCode({ code: "social_organic" })).toBe("social_organic");
    expect(enumCode({ code: OTHER_CODE, label_raw: "Farmers market" })).toBe(OTHER_CODE);
    expect(enumCode("email")).toBe("email");
  });

  it("refuses anything that holds no code", () => {
    expect(enumCode(null)).toBeNull();
    expect(enumCode("")).toBeNull();
    expect(enumCode({ code: "" })).toBeNull();
    expect(enumCode({ label_raw: "x" })).toBeNull();
    expect(enumCode(42)).toBeNull();
  });
});
