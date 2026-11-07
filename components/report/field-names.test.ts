// specs/field-names-en.json, held to the bank: every name is for a field a
// question writes, and keyWords says it.

import { describe, expect, it } from "vitest";
import bank from "../../specs/question-bank-v1.json";
import fieldNames from "../../specs/field-names-en.json";
import { keyWords } from "./figures";

const WRITES = new Set(
  (bank as unknown as { questions: { writes_to: string }[] }).questions.map((q) => q.writes_to),
);
const NAMES = (fieldNames as { names: Record<string, string> }).names;

describe("English field names", () => {
  it("name only fields a question writes, lowercase-first unless an acronym", () => {
    for (const [key, name] of Object.entries(NAMES)) {
      expect(WRITES.has(key), key).toBe(true);
      expect(name.trim(), key).not.toBe("");
      expect(/^[a-z]|^[A-Z]{2}/.test(name), `${key}: ${name}`).toBe(true);
    }
  });

  it("name every field a question writes", () => {
    expect([...WRITES].filter((k) => NAMES[k] === undefined)).toEqual([]);
  });

  it("keyWords says a named field by its name, and an entity's field as before", () => {
    expect(keyWords("offers.best_seller_id")).toBe("best seller");
    expect(keyWords("presence.website_url", false)).toBe("website address");
    expect(keyWords("offers.f8872a88-1607-4a5f-a35d-75fbdea4192b.cost_to_deliver")).toBe(
      "cost to deliver",
    );
  });
});
