import { describe, expect, it } from "vitest";
import { BASES, BASIS_MEANING, basisMix, basisOf, basisOfKey, gapWord, sourceLabel } from "./basis";

describe("basis — a named class from what produced the fact, never a percentage", () => {
  it("calls a connector measurement OBSERVED", () => {
    expect(basisOf({ status: "answered", source_kind: "connector" })).toBe("OBSERVED");
    // A connector aggregate is stored inferred; displaySourceKind reports it as "connector".
    expect(basisOf({ status: "inferred", source_kind: "connector" })).toBe("OBSERVED");
  });

  it("calls a document or a researched page OBSERVED", () => {
    expect(basisOf({ status: "answered", source_kind: "document" })).toBe("OBSERVED");
    expect(basisOf({ status: "answered", source_kind: "web_research" })).toBe("OBSERVED");
  });

  it("calls a derivation DERIVED", () => {
    expect(basisOf({ status: "inferred", source_kind: "inferred" })).toBe("DERIVED");
  });

  it("calls a system default ASSUMED", () => {
    expect(basisOf({ status: "answered", source_kind: "system_default" })).toBe("ASSUMED");
  });

  it("calls an exact owner answer STATED, and an estimate ESTIMATED", () => {
    expect(basisOf({ status: "answered", source_kind: "owner_input", confidence: 0.75 })).toBe(
      "STATED",
    );
    expect(
      basisOf({
        status: "answered",
        source_kind: "owner_input",
        note: "owner marked as estimate",
        confidence: 0.55,
      }),
    ).toBe("ESTIMATED");
    // The parser stores the owner's hedge words as the note, at 0.55.
    expect(
      basisOf({ status: "answered", source_kind: "owner_input", note: "about", confidence: 0.55 }),
    ).toBe("ESTIMATED");
    // The report's fact map has no note: the writer's confidence marks it.
    expect(basisOf({ status: "answered", source_kind: "owner_input", confidence: 0.55 })).toBe(
      "ESTIMATED",
    );
    expect(basisOf({ status: "answered", source_kind: "owner_input", note: "estimated" })).toBe(
      "ESTIMATED",
    );
  });

  it("keeps a confirmed conversation fact STATED", () => {
    expect(basisOf({ status: "answered", source_kind: "conversation", confidence: 0.7 })).toBe(
      "STATED",
    );
  });

  it("gives a gap no basis — it is a gap, not a weak fact (rule 5)", () => {
    for (const status of ["unknown", "skipped", "unasked", "not_applicable"]) {
      expect(basisOf({ status, source_kind: "owner_input", confidence: 0.75 })).toBeNull();
    }
    expect(basisOf({ status: "answered", source_kind: "mystery" })).toBeNull();
  });

  it("reads a connector series in derived_from as OBSERVED, a profile key from the map", () => {
    const map = { "offers.x.price": { status: "answered", source_kind: "owner_input" } };
    expect(basisOfKey("connector:stripe:revenue.daily", {})).toBe("OBSERVED");
    expect(basisOfKey("offers.x.price", map)).toBe("STATED");
    expect(basisOfKey("offers.y.price", map)).toBeNull();
  });

  it("summarises what a derivation rests on in class order", () => {
    expect(basisMix(["STATED", "OBSERVED", "STATED", null])).toBe(
      "1 OBSERVED · 2 STATED · 1 not recorded",
    );
    expect(basisMix([])).toBe("");
  });

  it("words every class and every gap", () => {
    for (const b of BASES) expect(BASIS_MEANING[b].length).toBeGreaterThan(0);
    expect(gapWord("unknown")).toBe("NOT KNOWN");
    expect(gapWord("not_applicable")).toBe("NOT APPLICABLE");
    expect(sourceLabel("connector")).toBe("measured");
    expect(sourceLabel("new_kind")).toBe("new kind");
  });
});
