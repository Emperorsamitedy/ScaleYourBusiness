// specs/vocabulary-labels-en.json, held to the bank: every label names a
// real code of a real vocabulary, so a typo can't silently do nothing.

import { describe, expect, it } from "vitest";
import bank from "../../specs/question-bank-v1.json";
import { englishLabel, englishLabels } from "./english-labels";

const VOCABULARIES = (bank as unknown as { vocabularies: Record<string, string[]> }).vocabularies;

describe("English vocabulary labels", () => {
  it("label only codes the bank has", () => {
    for (const [vocabulary, labels] of Object.entries(englishLabels())) {
      expect(VOCABULARIES[vocabulary], vocabulary).toBeDefined();
      for (const [code, label] of Object.entries(labels)) {
        expect(VOCABULARIES[vocabulary], `${vocabulary}.${code}`).toContain(code);
        expect(label.trim(), `${vocabulary}.${code}`).not.toBe("");
      }
    }
  });

  it("say a business type, a brand and an acronym the way people write them", () => {
    expect(englishLabel("business_type", "salon_beauty")).toBe("Hair or beauty salon");
    expect(englishLabel("ecommerce_platform", "woocommerce")).toBe("WooCommerce");
    expect(englishLabel("customer_type", "b2c")).toBe("Consumers (B2C)");
    expect(englishLabel("business_type", "restaurant")).toBeUndefined();
  });
});
