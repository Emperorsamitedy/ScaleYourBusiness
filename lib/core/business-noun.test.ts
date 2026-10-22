import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BUSINESS_NOUN, businessNoun } from "./business-noun";

describe("businessNoun — what a screen calls the business", () => {
  it("names a known business type", () => {
    expect(businessNoun("salon_beauty")).toBe("your salon");
    expect(businessNoun("gym_fitness")).toBe("your gym");
    expect(businessNoun("ecommerce_store")).toBe("your shop");
    expect(businessNoun("clinic_health")).toBe("your clinic");
  });

  it("reads the intake's {code} EnumValue the same as a bare code", () => {
    expect(businessNoun({ code: "barber" })).toBe("your barbershop");
    expect(businessNoun({ code: "photography_creative" })).toBe("your studio");
  });

  it("falls back to 'your business' for an unknown code, 'other' and a malformed value", () => {
    expect(businessNoun("space_tourism")).toBe("your business");
    expect(businessNoun({ code: "other", label_raw: "Dog grooming van" })).toBe("your business");
    expect(businessNoun({ code: "" })).toBe("your business");
    expect(businessNoun(42)).toBe("your business");
    // An inherited property is not a table entry.
    expect(businessNoun("toString")).toBe("your business");
  });

  it("falls back to 'your business' when the question is unanswered", () => {
    expect(businessNoun(null)).toBe("your business");
    expect(businessNoun(undefined)).toBe("your business");
    expect(businessNoun("")).toBe("your business");
  });

  it("names only codes the bank's business_type vocabulary holds", () => {
    const bank = JSON.parse(readFileSync("specs/question-bank-v1.json", "utf8")) as {
      vocabularies: Record<string, string[]>;
    };
    const types = bank.vocabularies["business_type"] ?? [];
    expect(types.length).toBeGreaterThan(0);
    for (const code of Object.keys(BUSINESS_NOUN)) expect(types, code).toContain(code);
    expect(BUSINESS_NOUN).not.toHaveProperty("other");
  });
});
