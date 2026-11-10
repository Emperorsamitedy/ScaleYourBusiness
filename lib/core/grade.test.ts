// Hard rule 3 (architecture-v2 D4): a derived figure inherits the LOWEST
// confidence grade of its inputs — read from the inputs, never from the
// ×0.9-haircut number §8.1 gives the inference itself.

import { describe, expect, it } from "vitest";
import { confidence } from "./confidence";
import {
  GRADE_FLOOR,
  InvalidGradeError,
  derivedGrade,
  gradeOf,
  lowestGrade,
  provenanceGrade,
  sourceGrade,
} from "./grade";

describe("gradeOf — the bands over a 0–1 confidence", () => {
  it("puts each boundary in the higher band, inclusive", () => {
    expect(gradeOf(confidence(1))).toBe("A");
    expect(gradeOf(confidence(GRADE_FLOOR.A))).toBe("A");
    expect(gradeOf(confidence(0.8499))).toBe("B");
    expect(gradeOf(confidence(GRADE_FLOOR.B))).toBe("B");
    expect(gradeOf(confidence(0.6999))).toBe("C");
    expect(gradeOf(confidence(GRADE_FLOOR.C))).toBe("C");
    expect(gradeOf(confidence(0.4999))).toBe("D");
    expect(gradeOf(confidence(0))).toBe("D");
  });

  it("matches §8.1's source bases: a connector is A, a precise owner answer B, an estimate C", () => {
    expect(gradeOf(confidence(0.95))).toBe("A");
    expect(gradeOf(confidence(0.75))).toBe("B");
    expect(gradeOf(confidence(0.55))).toBe("C");
    expect(gradeOf(confidence(0.2))).toBe("D");
  });
});

describe("lowestGrade", () => {
  it("is the worst of the grades given", () => {
    expect(lowestGrade(["A", "B", "C"])).toBe("C");
    expect(lowestGrade(["A", "D", "B"])).toBe("D");
    expect(lowestGrade(["B"])).toBe("B");
  });

  it("refuses an empty list rather than inventing a grade", () => {
    expect(() => lowestGrade([])).toThrow(InvalidGradeError);
  });
});

describe("derivedGrade — hard rule 3", () => {
  it("inherits the lowest input grade", () => {
    expect(derivedGrade([confidence(0.95), confidence(0.75), confidence(0.55)])).toBe("C");
  });

  it("passing case: two A inputs give A, even though min × 0.9 (0.774) would read as B", () => {
    // The ×0.9 haircut belongs to the number. The grade comes from the
    // inputs: two connector-grade facts make a connector-grade figure.
    expect(derivedGrade([confidence(0.95), confidence(0.86)])).toBe("A");
    expect(gradeOf(confidence(Math.min(0.95, 0.86) * 0.9))).toBe("B");
  });

  it("failing case: one weak input drags the whole figure to its grade — never averaged up", () => {
    // An average of these (0.63) would read C. The rule says D.
    expect(derivedGrade([confidence(0.95), confidence(0.5), confidence(0.45)])).toBe("D");
  });

  it("has no grade without inputs", () => {
    expect(() => derivedGrade([])).toThrow(InvalidGradeError);
  });
});

// ── §6.1 of the v1 build spec: grades come from provenance, not from a band ──
//
// A  measured from a connected system, cross-checked against a second source
// B  measured from one connected system
// C  derived from measured inputs with modelling assumptions
// D  depends on at least one owner-stated number

describe("provenanceGrade — §6.1", () => {
  it("measured is B, and A only once a second source cross-checks it", () => {
    expect(provenanceGrade({ source: "measured" })).toBe("B");
    expect(provenanceGrade({ source: "measured", cross_checked: true })).toBe("A");
  });

  it("anything the owner stated is D, however confident they sounded", () => {
    expect(provenanceGrade({ source: "stated" })).toBe("D");
  });

  it("a peer or official reference used as this business's figure is a model: C", () => {
    expect(provenanceGrade({ source: "peer" })).toBe("C");
    expect(provenanceGrade({ source: "official" })).toBe("C");
  });

  it("passing case: arithmetic on measured inputs keeps their grade", () => {
    expect(provenanceGrade({ source: "derived", inputs: ["A", "A"] })).toBe("A");
    expect(provenanceGrade({ source: "derived", inputs: ["A", "B"] })).toBe("B");
  });

  it("modelling assumptions cap a derived figure at C", () => {
    expect(provenanceGrade({ source: "derived", inputs: ["A", "A"], modelled: true })).toBe("C");
    expect(provenanceGrade({ source: "derived", inputs: ["D"], modelled: true })).toBe("D");
  });

  it("failing case: break-even on one stated fixed cost is D — no averaging, no rounding up", () => {
    expect(provenanceGrade({ source: "derived", inputs: ["A", "A", "A", "D"] })).toBe("D");
  });

  it("a derived figure with no inputs has no grade", () => {
    expect(() => provenanceGrade({ source: "derived", inputs: [] })).toThrow(InvalidGradeError);
    expect(() => provenanceGrade({ source: "derived" })).toThrow(InvalidGradeError);
  });
});

describe("sourceGrade — a fact's SourceRef read as §6.1 provenance", () => {
  it("a connector reading, or an aggregate of connector series, is measured: B", () => {
    expect(sourceGrade({ kind: "connector", connector_id: "stripe" })).toBe("B");
    expect(
      sourceGrade({
        kind: "inferred",
        derived_from: ["connector:stripe:revenue.daily"],
        method: "sum of 30 days",
      }),
    ).toBe("B");
  });

  it("an owner's answer — typed or said — is D", () => {
    expect(sourceGrade({ kind: "owner_input" })).toBe("D");
    expect(sourceGrade({ kind: "conversation", utterance_id: "u1" })).toBe("D");
  });

  it("an inference from owner answers is D: its inputs can't be shown better", () => {
    expect(
      sourceGrade({
        kind: "inferred",
        derived_from: ["revenue.monthly_revenue", "connector:stripe:orders.daily"],
        method: "x",
      }),
    ).toBe("D");
  });

  it("a parsed document is measured; web research and defaults are models", () => {
    expect(sourceGrade({ kind: "document", document_id: "d1" })).toBe("B");
    expect(sourceGrade({ kind: "web_research", researched_url: "https://x" })).toBe("C");
    expect(sourceGrade({ kind: "system_default" })).toBe("C");
  });

  it("an unreadable source is D, never a guess upward", () => {
    expect(sourceGrade(null)).toBe("D");
    expect(sourceGrade({ kind: "made_up" })).toBe("D");
  });
});
