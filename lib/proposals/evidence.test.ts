// The evidence lines' "sources disagree" box shows only what an open
// contradiction finding says — never a disagreement the data doesn't hold.

import "dotenv/config";
import { describe, expect, it } from "vitest";
import { disagreementsFor, sourceFieldsOf } from "./evidence";

const finding = (over: Partial<Parameters<typeof disagreementsFor>[0][number]> = {}) => ({
  id: "f1",
  kind: "contradiction",
  field_keys: ["economics.aov", "economics.revenue_monthly"],
  message: { en: "Your stated revenue and order value don't add up." },
  resolution: null,
  ...over,
});

describe("disagreementsFor", () => {
  it("returns an open contradiction that touches a cited field, with its message", () => {
    const out = disagreementsFor([finding()], new Set(["economics.aov"]));
    expect(out).toEqual([
      {
        finding_id: "f1",
        field_keys: ["economics.aov", "economics.revenue_monthly"],
        message: "Your stated revenue and order value don't add up.",
      },
    ]);
  });

  it("ignores resolved findings, other kinds, and findings on fields the proposal doesn't cite", () => {
    const keys = new Set(["economics.aov"]);
    expect(disagreementsFor([finding({ resolution: { method: "owner" } })], keys)).toEqual([]);
    expect(disagreementsFor([finding({ kind: "gap" })], keys)).toEqual([]);
    expect(disagreementsFor([finding({ field_keys: ["identity.legal_name"] })], keys)).toEqual([]);
  });

  it("words a finding with no readable message from its fields", () => {
    const out = disagreementsFor([finding({ message: null })], new Set(["economics.aov"]));
    expect(out[0]?.message).toBe("economics.aov and economics.revenue_monthly do not agree.");
  });
});

describe("sourceFieldsOf", () => {
  it("collects every named source field once, and skips assumptions without one", () => {
    expect(
      sourceFieldsOf([
        { assumptions: [{ source_field: "a.b" }, { source_field: null }, { source_field: "a.b" }] },
        { assumptions: [{ source_field: "c.d" }] },
        { assumptions: "not a list" },
        null,
      ]),
    ).toEqual(["a.b", "c.d"]);
  });

  it("returns nothing when no assumption names a field", () => {
    expect(sourceFieldsOf([{ assumptions: [{ statement: "x", source_field: null }] }])).toEqual([]);
  });
});
