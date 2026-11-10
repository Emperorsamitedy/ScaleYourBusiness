// Hard rule 3 (architecture-v2 D4): a derived figure inherits the LOWEST
// confidence grade of its inputs — read from the inputs, never from the
// ×0.9-haircut number §8.1 gives the inference itself.

import { describe, expect, it } from "vitest";
import { confidence } from "./confidence";
import { GRADE_FLOOR, InvalidGradeError, derivedGrade, gradeOf, lowestGrade } from "./grade";

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
