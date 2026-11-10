// Confidence grades — architecture-v2 D4, hard rule 3; data-model-v1 §8.1.
//
// Bands over the existing 0–1 confidence. A derived figure's grade is the
// lowest of its inputs' grades, read from the inputs themselves. §8.1's
// min(inputs) × 0.9 stays the inferred number's own confidence, but that
// haircut can drop below the weakest input's band, and the grade must not.

import type { Confidence } from "./confidence";

export type Grade = "A" | "B" | "C" | "D";

/** Each grade's inclusive floor. D is everything below C. */
export const GRADE_FLOOR = { A: 0.85, B: 0.7, C: 0.5 } as const;

/** Best first: a lower index is a better grade. */
export const GRADES: readonly Grade[] = ["A", "B", "C", "D"];

export class InvalidGradeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidGradeError";
  }
}

export function gradeOf(c: Confidence): Grade {
  if (c >= GRADE_FLOOR.A) return "A";
  if (c >= GRADE_FLOOR.B) return "B";
  if (c >= GRADE_FLOOR.C) return "C";
  return "D";
}

export function isGrade(value: unknown): value is Grade {
  return typeof value === "string" && (GRADES as readonly string[]).includes(value);
}

/** The worst of the grades given. An empty list has no grade, and says so. */
export function lowestGrade(grades: readonly Grade[]): Grade {
  if (grades.length === 0) throw new InvalidGradeError("no grades to take the lowest of");
  return grades.reduce((worst, g) => (GRADES.indexOf(g) > GRADES.indexOf(worst) ? g : worst));
}

/** Hard rule 3: the grade of a figure derived from these inputs. */
export function derivedGrade(inputs: readonly Confidence[]): Grade {
  if (inputs.length === 0) throw new InvalidGradeError("a derived figure needs inputs to grade");
  return lowestGrade(inputs.map(gradeOf));
}
