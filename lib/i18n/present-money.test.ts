// The multi-market spec: "A HUF amount renders as whole forints with
// Hungarian separators in every surface" — in every one of the seven
// languages, from fillér, never as "35 412,50".

import { describe, expect, it } from "vitest";
import { money } from "../core/money";
import { presentAmount, presentMoney } from "./format";
import { LOCALES } from "./locales";

describe("presentMoney", () => {
  it("HUF is whole forints with Hungarian separators in every language", () => {
    for (const locale of LOCALES) {
      const shown = presentMoney(money(3_541_250, "HUF"), locale);
      expect(shown, locale).toBe("35 413 Ft");
      expect(shown, locale).not.toMatch(/[.,]\d{1,2}(?!\d)/);
    }
  });

  it("EUR follows the reader's language, with the table's two decimals", () => {
    expect(presentMoney(money(123_456, "EUR"), "en")).toBe("€1,234.56");
    expect(presentMoney(money(123_456, "EUR"), "de-DE")).toBe("1.234,56 €");
    // CLDR's Hungarian writes euros with the code, and groups from five digits.
    expect(presentMoney(money(123_456, "EUR"), "hu-HU")).toBe("1234,56 EUR");
  });

  it("whole rounds a headline figure to whole major units", () => {
    expect(presentMoney(money(2_279_950, "EUR"), "en", { whole: true })).toBe("€22,800");
    expect(presentMoney(money(2_279_950, "HUF"), "hu-HU", { whole: true })).toBe("22 800 Ft");
  });

  it("is exact past where a float would drift", () => {
    expect(presentMoney(money(900_719_925_474_099, "EUR"), "en")).toBe("€9,007,199,254,740.99");
  });

  it("presentAmount gives the number alone", () => {
    expect(presentAmount(money(3_541_250, "HUF"), "en")).toBe("35 413");
    expect(presentAmount(money(123_456, "EUR"), "en")).toBe("1,234.56");
  });
});
