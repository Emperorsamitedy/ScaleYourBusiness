import { describe, expect, it } from "vitest";
import {
  add,
  CurrencyMismatchError,
  format,
  InvalidMoneyError,
  money,
  multiply,
  subtract,
  sum,
  toDecimalString,
  totalsByCurrency,
} from "./money";

describe("money() constructor", () => {
  it("accepts integer minor units and an ISO code", () => {
    expect(money(420_000_000, "HUF")).toEqual({ amount_minor: 420_000_000, currency: "HUF" });
  });

  it("rejects a float — rule 1, never a float", () => {
    expect(() => money(19.99, "EUR")).toThrow(InvalidMoneyError);
  });

  it("rejects NaN and unsafe magnitudes", () => {
    expect(() => money(Number.NaN, "EUR")).toThrow(InvalidMoneyError);
    expect(() => money(Number.MAX_SAFE_INTEGER + 1, "EUR")).toThrow(InvalidMoneyError);
  });

  it("rejects a malformed currency — rule 1, never a bare number", () => {
    expect(() => money(100, "")).toThrow(InvalidMoneyError);
    expect(() => money(100, "eur")).toThrow(InvalidMoneyError);
    expect(() => money(100, "EURO")).toThrow(InvalidMoneyError);
  });
});

describe("add / subtract", () => {
  it("adds within one currency", () => {
    expect(add(money(1000, "HUF"), money(500, "HUF"))).toEqual(money(1500, "HUF"));
  });

  it("subtracts within one currency, allowing negative results", () => {
    expect(subtract(money(500, "EUR"), money(800, "EUR"))).toEqual(money(-300, "EUR"));
  });

  it("refuses to add across currencies", () => {
    expect(() => add(money(1000, "HUF"), money(1000, "EUR"))).toThrow(CurrencyMismatchError);
  });

  it("refuses to subtract across currencies", () => {
    expect(() => subtract(money(1000, "EUR"), money(1000, "HUF"))).toThrow(CurrencyMismatchError);
  });
});

describe("multiply", () => {
  it("multiplies by an integer quantity", () => {
    expect(multiply(money(2500, "EUR"), 4)).toEqual(money(10_000, "EUR"));
  });

  it("rounds half away from zero on fractional factors", () => {
    expect(multiply(money(1001, "EUR"), 0.5)).toEqual(money(501, "EUR")); // 500.5 → 501
    expect(multiply(money(-1001, "EUR"), 0.5)).toEqual(money(-501, "EUR")); // -500.5 → -501
  });

  it("never emits negative zero", () => {
    expect(Object.is(multiply(money(-1, "EUR"), 0).amount_minor, 0)).toBe(true);
  });

  it("rejects a non-finite factor", () => {
    expect(() => multiply(money(100, "EUR"), Number.POSITIVE_INFINITY)).toThrow(InvalidMoneyError);
  });
});

describe("sum — the two-currency case that must refuse to total silently", () => {
  // The spec's own example (§3.3): a Hungarian shop with HUF revenue and
  // Meta ads billed in EUR. One profile, two currencies.
  const hufRevenue = money(420_000_000, "HUF"); // 4 200 000 Ft in fillér
  const eurAdSpend = money(25_000, "EUR"); // €250.00 in cents

  it("REFUSES to total HUF revenue with EUR ad spend — throws, no silent number", () => {
    expect(() => sum([hufRevenue, eurAdSpend], "HUF")).toThrow(CurrencyMismatchError);
  });

  it("names both currencies and the escape hatch in the error", () => {
    expect(() => sum([hufRevenue, eurAdSpend], "HUF")).toThrow(/HUF.*EUR|EUR.*HUF/);
    expect(() => sum([hufRevenue, eurAdSpend], "HUF")).toThrow(/totalsByCurrency/);
  });

  it("sums a single-currency list", () => {
    expect(sum([money(100, "HUF"), money(250, "HUF")], "HUF")).toEqual(money(350, "HUF"));
  });

  it("rejects a list whose currency differs from the declared one", () => {
    expect(() => sum([money(100, "EUR")], "HUF")).toThrow(CurrencyMismatchError);
  });

  it("totals an empty list to zero in the declared currency", () => {
    expect(sum([], "EUR")).toEqual(money(0, "EUR"));
  });
});

describe("totalsByCurrency — the legal way to total a mixed profile", () => {
  it("groups the spec's two-currency profile correctly", () => {
    const totals = totalsByCurrency([
      money(420_000_000, "HUF"),
      money(25_000, "EUR"),
      money(80_000_000, "HUF"),
    ]);
    expect(totals.get("HUF")).toEqual(money(500_000_000, "HUF"));
    expect(totals.get("EUR")).toEqual(money(25_000, "EUR"));
    expect(totals.size).toBe(2);
  });

  it("returns an empty map for an empty list", () => {
    expect(totalsByCurrency([]).size).toBe(0);
  });
});

describe("format", () => {
  it("formats EUR from cents", () => {
    expect(format(money(123_456, "EUR"), "en")).toBe("€1,234.56");
  });

  it("formats HUF from fillér with two minor digits", () => {
    // 420 000 000 fillér = 4 200 000.00 Ft. Intl separates the code from
    // the number with a non-breaking space.
    expect(format(money(420_000_000, "HUF"), "en")).toBe("HUF 4,200,000.00");
  });

  it("formats a zero-decimal currency without dividing", () => {
    expect(format(money(5000, "JPY"), "en")).toBe("¥5,000");
  });
});

describe("toDecimalString — idea 49's export, exact digits and no float", () => {
  it("places the decimal mark by the currency's exponent", () => {
    expect(toDecimalString(money(499_000, "HUF"))).toBe("4990.00");
    expect(toDecimalString(money(123_456, "EUR"))).toBe("1234.56");
    expect(toDecimalString(money(1_200, "JPY"))).toBe("1200");
    expect(toDecimalString(money(1_234_567, "KWD"))).toBe("1234.567");
  });

  it("pads small amounts and keeps the sign", () => {
    expect(toDecimalString(money(5, "EUR"))).toBe("0.05");
    expect(toDecimalString(money(-5, "EUR"))).toBe("-0.05");
    expect(toDecimalString(money(0, "EUR"))).toBe("0.00");
    expect(toDecimalString(money(-120_050, "HUF"))).toBe("-1200.50");
  });

  it("prints the largest safe integer exactly, where dividing would round", () => {
    expect(toDecimalString(money(Number.MAX_SAFE_INTEGER, "EUR"))).toBe("90071992547409.91");
  });

  it("refuses what money() refuses — a float or a bad currency is never printed", () => {
    expect(() => toDecimalString({ amount_minor: 12.5, currency: "EUR" })).toThrow(
      InvalidMoneyError,
    );
    expect(() => toDecimalString({ amount_minor: 100, currency: "euro" })).toThrow(
      InvalidMoneyError,
    );
  });
});
