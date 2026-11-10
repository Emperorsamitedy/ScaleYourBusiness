// Confidence grades — the v1 build spec §6.1, hard rule 3.
//
// A grade comes from PROVENANCE (§6.1): provenanceGrade and sourceGrade
// below. A  measured and cross-checked against a second source; B measured
// from one connected system; C derived from measured inputs with modelling
// assumptions; D anything that depends on an owner-stated number.
//
// The numeric bands that follow (gradeOf, derivedGrade) were architecture-v2
// D4's first cut, superseded by §6.1 on 2026-11-10. They are kept, not
// deleted, for the 0–1 confidence the profile still carries, but no figure
// takes its grade from them any more.
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

// ── §6.1: grades from provenance ─────────────────────────────────────────

/** §6.1's figure sources. */
export const FIGURE_SOURCES = ["measured", "stated", "derived", "peer", "official"] as const;
export type FigureSource = (typeof FIGURE_SOURCES)[number];

export function isFigureSource(value: unknown): value is FigureSource {
  return typeof value === "string" && (FIGURE_SOURCES as readonly string[]).includes(value);
}

export interface Provenance {
  source: FigureSource;
  /** measured only: a second, independent source agrees (A). */
  cross_checked?: boolean;
  /** derived only: the formula assumes something it didn't measure (C at best). */
  modelled?: boolean;
  /** derived only: the grades of the figures it was computed from. */
  inputs?: readonly Grade[];
}

/**
 * §6.1 and hard rule 3. A derived figure takes the LOWEST grade of its
 * inputs — no averaging, no optimistic rounding — and modelling caps it at
 * C. A peer or official reference standing in for this business's own
 * number is a model, so C.
 */
export function provenanceGrade(p: Provenance): Grade {
  switch (p.source) {
    case "measured":
      return p.cross_checked === true ? "A" : "B";
    case "stated":
      return "D";
    case "peer":
    case "official":
      return "C";
    case "derived": {
      const inputs = p.inputs ?? [];
      if (inputs.length === 0) {
        throw new InvalidGradeError("a derived figure needs the grades of its inputs");
      }
      const worst = lowestGrade(inputs);
      return p.modelled === true ? lowestGrade([worst, "C"]) : worst;
    }
  }
}

const CONNECTOR_PREFIX = "connector:";

/**
 * A fact's SourceRef (data-model-v1 §3.2) read as §6.1 provenance. Pure and
 * import-free, so the economics engine and the figure store share it. An
 * inference is B only when every input it names is a connector series; any
 * other inference may rest on an owner's answer, and can't be shown better
 * than D from its reference alone.
 */
export function sourceGrade(source: unknown): Grade {
  if (typeof source !== "object" || source === null) return "D";
  const s = source as { kind?: unknown; derived_from?: unknown };
  switch (s.kind) {
    case "connector":
    case "document":
      return "B";
    case "inferred":
      return Array.isArray(s.derived_from) &&
        s.derived_from.length > 0 &&
        s.derived_from.every((d) => typeof d === "string" && d.startsWith(CONNECTOR_PREFIX))
        ? "B"
        : "D";
    case "web_research":
    case "system_default":
      return "C";
    default:
      // owner_input, conversation, and anything unreadable.
      return "D";
  }
}
