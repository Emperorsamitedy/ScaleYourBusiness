// The chat's reading of a value — review 2026-10-23, #4 and #13. The same
// exact amount reader as the imports: "12,50 €" is €12.50, "1.500 Ft" is a
// question back, "incl VAT" is never a currency, and a percent answered as
// a fraction is asked about rather than stored as 0.35 points.

import "dotenv/config";
import { describe, expect, it } from "vitest";
import type { InputSpec } from "../interviewer/harness/answers";
import { isAskBack, isPercentSpec, wireFor } from "./changes";

const money: InputSpec = { type: "money" };
const number: InputSpec = { type: "number" };

describe("money in chat goes through the one exact reader", () => {
  it("reads unambiguous European and English amounts exactly, as decimal strings", () => {
    expect(wireFor(money, "12,50 €", [], null)).toEqual({ amount_major: "12.50", currency: "EUR" });
    expect(wireFor(money, "1.234,56 EUR", [], null)).toEqual({
      amount_major: "1234.56",
      currency: "EUR",
    });
    expect(wireFor(money, "$1,234.56", [], null)).toEqual({
      amount_major: "1234.56",
      currency: "USD",
    });
    expect(wireFor(money, "1 200 Ft", [], null)).toEqual({ amount_major: "1200", currency: "HUF" });
    expect(wireFor(money, "12.5", [], "GBP")).toEqual({ amount_major: "12.5", currency: "GBP" });
  });

  it("asks back on a lone 1.500, never guessing 1.5 or 1500", () => {
    const out = wireFor(money, "1.500 Ft", [], null);
    expect(isAskBack(out)).toBe(true);
    expect((out as { ask: string }).ask).toBe(
      "Did you mean 1500 or 1.5? Write it as 1500 or 1.5 and I'll take it exactly.",
    );
    const twelve = wireFor(number, "12.000", [], null);
    expect(isAskBack(twelve) && twelve.ask).toContain("Did you mean 12000 or 12?");
  });

  it("takes only an ISO 4217 code as the currency: 'incl VAT' is not one (#13)", () => {
    expect(wireFor(money, "45 incl VAT", [], "HUF")).toEqual({
      amount_major: "45",
      currency: "HUF",
    });
    expect(wireFor(money, "45 EUR incl VAT", [], "HUF")).toEqual({
      amount_major: "45",
      currency: "EUR",
    });
    expect(wireFor(money, "45 VAT EUR", [], null)).toEqual({ amount_major: "45", currency: "EUR" });
  });

  it("a number still reads as a number, and nothing that isn't one", () => {
    expect(wireFor(number, "about 35", [], null)).toBe(35);
    expect(wireFor(number, "0.35", [], null)).toBe(0.35);
    expect(wireFor(number, "lots", [], null)).toBeNull();
  });
});

describe("percent questions are the bank's 0–100 numbers", () => {
  it("knows one by its bounds", () => {
    expect(isPercentSpec({ type: "number", min: 0, max: 100 })).toBe(true);
    expect(isPercentSpec({ type: "number", min: -100, max: 100 })).toBe(true);
    expect(isPercentSpec({ type: "number", min: 0 })).toBe(false);
    expect(isPercentSpec({ type: "number" })).toBe(false);
  });
});
