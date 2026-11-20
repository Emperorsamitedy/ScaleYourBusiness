import { describe, expect, it } from "vitest";
import {
  columnDecimals,
  fmtDate,
  fmtDay,
  forecastRange,
  isFigureText,
  keyWords,
  numberDecimals,
  parseReprMoney,
  rangeText,
  refigure,
  refigureNumber,
  severityFlag,
  signedMoney,
} from "./figures";

const NB = ",";
const eur = (amount_minor: number) => ({ amount_minor, currency: "EUR" });

describe("one decimal count per money column", () => {
  it("uses whole units when every amount is whole", () => {
    expect(columnDecimals([eur(29000), eur(100), null])).toBe(0);
  });
  it("uses the exponent for every row once one amount has cents", () => {
    expect(columnDecimals([eur(29000), eur(1250)])).toBe(2);
  });
  it("never adds decimals to a zero-exponent currency", () => {
    expect(columnDecimals([{ amount_minor: 1234, currency: "JPY" }])).toBe(0);
  });
  it("keeps plain number columns whole unless a value is fractional", () => {
    expect(numberDecimals([3, 40, null])).toBe(0);
    expect(numberDecimals([3, 40.5])).toBe(1);
  });
});

describe("signed money", () => {
  it("signs gains, uses a true minus for losses, and leaves zero unsigned", () => {
    expect(signedMoney(eur(34000))).toBe("+340");
    expect(signedMoney(eur(-12000))).toBe("−120");
    expect(signedMoney(eur(0))).toBe("0");
    expect(signedMoney(eur(20))).toBe("0"); // rounds to zero at whole units: no "+0"
  });
});

describe("forecasts are ranges, never a single point", () => {
  const c = (amount: number | null) => ({
    case: "x",
    profit_delta_monthly: amount === null ? null : eur(amount),
  });

  it("spans downside to upside", () => {
    const r = forecastRange(c(-12000), c(34000), c(9000));
    expect(r).not.toBeNull();
    expect(rangeText(r!)).toBe(`−120 to +340`);
  });

  it("folds in a base case that falls outside the two", () => {
    const r = forecastRange(c(-1000), c(2000), c(5000));
    expect(r!.high.amount_minor).toBe(5000);
  });

  it("refuses when either end has no figure", () => {
    expect(forecastRange(c(null), c(34000), c(9000))).toBeNull();
    expect(forecastRange(c(-1000), c(null))).toBeNull();
  });

  it("refuses to span two currencies (rule 1)", () => {
    expect(
      forecastRange(
        { case: "downside", profit_delta_monthly: eur(-100) },
        { case: "upside", profit_delta_monthly: { amount_minor: 500, currency: "HUF" } },
      ),
    ).toBeNull();
  });

  it("prints both ends at one decimal count", () => {
    expect(rangeText(forecastRange(c(-12050), c(34000))!)).toBe(`−120.50 to +340.00`);
  });
});

describe("re-figuring server-humanised money", () => {
  it("recovers exact minor units from repr()'d text", () => {
    expect(parseReprMoney("1 234.5 EUR")).toEqual(eur(123450));
    expect(parseReprMoney("-40 EUR")).toEqual(eur(-4000));
    expect(parseReprMoney("4 090 HUF")).toEqual({ amount_minor: 409000, currency: "HUF" });
    expect(parseReprMoney("1 500 JPY")).toEqual({ amount_minor: 1500, currency: "JPY" });
  });

  it("leaves text that is not money alone", () => {
    expect(parseReprMoney("Budapest")).toBeNull();
    expect(parseReprMoney("12")).toBeNull();
    expect(refigure("social organic")).toBe("social organic");
  });

  it("re-prints through the number grammar, with the true exponent", () => {
    expect(refigure("1 234.5 EUR")).toBe(`€1${NB}234.50`);
    expect(refigure("1 500 JPY")).toBe(`1${NB}500 JPY`);
    // repr() divided a 3-decimal currency by 100; the true exponent puts it right.
    expect(refigure("12.34 KWD")).toBe("1.234 KWD");
  });

  it("knows which values are figures", () => {
    expect(isFigureText("1 234.5 EUR")).toBe(true);
    expect(isFigureText("12000")).toBe(true);
    expect(isFigureText("Instagram")).toBe(false);
    expect(refigureNumber("12000")).toBe(`12${NB}000`);
    expect(refigureNumber("0.35")).toBe("0.35");
  });
});

describe("dates carry the year", () => {
  it("prints day, month and year from a timestamp or a date", () => {
    expect(fmtDate("2026-10-17T09:30:00.000Z")).toBe("17 Oct 2026");
    expect(fmtDate("2026-01-02")).toBe("2 Jan 2026");
  });
  it("returns unparseable input unchanged", () => {
    expect(fmtDate("last week")).toBe("last week");
  });
});

describe("severity is a word", () => {
  it("maps each severity to a flag word and a tint", () => {
    expect(severityFlag("critical")).toEqual({ word: "ACT NOW", tone: "alarm" });
    expect(severityFlag("high")).toEqual({ word: "HIGH", tone: "drift" });
    expect(severityFlag("medium")).toEqual({ word: "MEDIUM", tone: "low" });
    expect(severityFlag("low")).toEqual({ word: "LOW", tone: "low" });
  });
});

describe("field keys as words", () => {
  it("drops the section and any entity id", () => {
    expect(keyWords("offers.3f2b1c9a-1111-4222-8333-444455556666.cost_to_deliver")).toBe(
      "cost to deliver",
    );
    expect(keyWords("revenue.monthly_revenue")).toBe("monthly revenue");
    expect(keyWords("offers.3f2b1c9a-1111-4222-8333-444455556666.volume_period")).toBe(
      "sold per month",
    );
    expect(keyWords("identity")).toBe("identity");
  });
});

describe("fmtDay — the designs' short date", () => {
  const now = new Date("2026-10-17T12:00:00Z");
  it("drops the year only when it is this year", () => {
    expect(fmtDay("2026-10-03T09:00:00Z", now)).toBe("03 Oct");
    expect(fmtDay("2026-09-14", now)).toBe("14 Sep");
    expect(fmtDay("2025-12-31T00:00:00Z", now)).toBe("31 Dec 2025");
  });
  it("returns unparseable input as given", () => {
    expect(fmtDay("someday", now)).toBe("someday");
  });
});
