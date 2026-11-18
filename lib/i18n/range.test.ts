// L7 (the owner, 2026-11-18): "no em and en dashes throughout the app". A
// range built in code says "to" in the reader's language, and what stands
// for "no value" is a plain hyphen.

import { describe, expect, it } from "vitest";
import { LOCALES } from "./locales";
import { NO_VALUE, rangeOf } from "./range";

describe("rangeOf", () => {
  it("says the two ends with the language's own word", () => {
    expect(rangeOf("+€136", "+€1,213")).toBe("+€136 to +€1,213");
    expect(rangeOf("136 €", "1.213 €", "de-DE")).toBe("136 € bis 1.213 €");
    expect(rangeOf("136 €", "1213 €", "es-ES")).toBe("136 € a 1213 €");
    expect(rangeOf("136 €", "1 213 €", "fr-FR")).toBe("136 € à 1 213 €");
    expect(rangeOf("€136", "€1,213", "zh-Hans")).toBe("€136 至 €1,213");
  });

  it("takes a spaced hyphen where a word would bend the grammar around it", () => {
    expect(rangeOf("136 €", "1 213 €", "hu-HU")).toBe("136 € - 1 213 €");
    expect(rangeOf("136 €", "1 213 €", "ru-RU")).toBe("136 € - 1 213 €");
  });

  it("never writes an en dash or an em dash, in any language", () => {
    for (const locale of LOCALES) {
      expect(rangeOf("1", "2", locale), locale).not.toMatch(/[–—]/);
      expect(rangeOf("1", "2", locale), locale).toMatch(/^1.+2$/);
    }
  });

  it("marks no value with a hyphen, not a long dash", () => {
    expect(NO_VALUE).toBe("-");
    expect(NO_VALUE).not.toMatch(/[–—]/);
  });
});
