// Intake areas — the tile row above the question (owner design s1).
//
// One area per bank section. Its status is arithmetic over data: the
// bank's stored ConditionExpr records decide which questions apply (the
// same evaluator the resolver uses), and the current responses decide how
// far each area has got. No per-question code (rule 4) and no model.
//
// "Blocked" is the interesting one. A section can hold questions that
// exist for this business but cannot be asked yet, because their
// condition reads a fact nobody has recorded — 1.4.1.5a needs
// fulfilment.ships_products, which needs identity.sells. That is
// different from a condition that is FALSE on recorded facts (a
// services-only business and the inventory questions): those questions
// do not exist for this business, and a section made only of them is
// left out entirely. unmetDependencies() tells the two apart by walking
// the expression for the fields whose absence is what keeps it false.

import type { ConditionContext, ConditionExpr } from "../conditions/evaluate";
import { evaluate } from "../conditions/evaluate";
import { VALUE_BEARING_STATUSES } from "../core/field-status";
import type { ProfileSection } from "../profile/sections";
import { PROFILE_SECTIONS, sectionOfFieldKey } from "../profile/sections";
import type { AreaBar, IntakeArea } from "./types";

/** Natural order for bank ids: "1.10" after "1.9", "1.4.1.5a" after "1.4.1.5". */
export function naturalIdCompare(a: string, b: string): number {
  const as = a.split(".");
  const bs = b.split(".");
  for (let i = 0; i < Math.max(as.length, bs.length); i++) {
    const x = as[i];
    const y = bs[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = parseInt(x, 10);
    const yn = parseInt(y, 10);
    if (xn !== yn) return xn - yn;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** What a responded key's current record is, for its bar on the tile. */
export type ResponseKind = "owner" | "measured" | "derived" | "unknown";

/**
 * The kind of one current record, read from its status and source — never
 * from the question. A connector measurement is "measured" (displaySource
 * Kind's "connector"); any other inferred value is "derived" (rule 6); an
 * explicit unknown stays "unknown" (rule 5); everything else the owner gave.
 */
export function responseKindOf(status: string, sourceKind: string): ResponseKind | null {
  if (status === "unknown") return "unknown";
  if (status !== "answered" && status !== "inferred") return null;
  if (sourceKind === "connector") return "measured";
  if (sourceKind === "inferred") return "derived";
  return "owner";
}

/** What the area computation needs of one bank question. */
export interface AreaQuestion {
  id: string;
  section: ProfileSection;
  writes_to: string;
  condition: ConditionExpr | null;
}

function baseKey(fieldKey: string): string {
  return fieldKey.endsWith(".length") ? fieldKey.slice(0, -".length".length) : fieldKey;
}

function recorded(field: string, ctx: ConditionContext): boolean {
  const view = ctx.get(baseKey(field));
  return view !== undefined && VALUE_BEARING_STATUSES.has(view.status) && view.value !== null;
}

/**
 * The fields whose missing values stop `expr` from evaluating to `want`.
 * Empty when the expression already evaluates to `want`, and empty when it
 * fails only on facts that ARE recorded — that question simply does not
 * apply. Mirrors evaluate()'s missing-value semantics: every value
 * comparison is false on a missing field; `unanswered` is true on one.
 */
export function unmetDependencies(
  expr: ConditionExpr,
  ctx: ConditionContext,
  want = true,
): string[] {
  if (evaluate(expr, ctx) === want) return [];
  switch (expr.op) {
    case "not":
      return unmetDependencies(expr.term, ctx, !want);
    case "and":
    case "or": {
      const failing = expr.terms.filter((t) => evaluate(t, ctx) !== want);
      const perTerm = failing.map((t) => unmetDependencies(t, ctx, want));
      // Wanting an AND true (or an OR false) needs EVERY failing term to
      // turn: one that fails on recorded facts alone settles it, and no
      // new fact can help. Wanting an OR true (or an AND false) needs any
      // one term to turn — the union names every way forward.
      const needsAll = (expr.op === "and") === want;
      if (needsAll && perTerm.some((deps) => deps.length === 0)) return [];
      return [...new Set(perTerm.flat())];
    }
    case "unanswered":
      // True on a missing field, so it can only be held back by a field
      // that would have to be recorded for it to turn false.
      return !want && !recorded(expr.field, ctx) ? [baseKey(expr.field)] : [];
    default:
      return want && !recorded(expr.field, ctx) ? [baseKey(expr.field)] : [];
  }
}

/**
 * The area a dependency field is answered in: the section of the bank
 * question that writes it (the area the owner would go to), else the
 * field key's own home section.
 */
export function areaOfField(
  field: string,
  questions: readonly AreaQuestion[],
): ProfileSection | null {
  const exact = questions.find((q) => q.writes_to === field);
  if (exact) return exact.section;
  const parent = questions
    .filter((q) => field.startsWith(`${q.writes_to}.`))
    .sort((a, b) => b.writes_to.length - a.writes_to.length)[0];
  if (parent) return parent.section;
  try {
    return sectionOfFieldKey(field);
  } catch {
    return null;
  }
}

export interface AreaInput {
  questions: readonly AreaQuestion[];
  ctx: ConditionContext;
  /** writes_to keys holding a response: answered, inferred, or an explicit unknown. */
  responded: ReadonlySet<string>;
  /** writes_to keys whose current record is a skip. */
  skippedKeys: ReadonlySet<string>;
  /** The section of the question being asked right now, if any. */
  activeSection?: string | null;
  /** The id of the question being asked right now — its bar is "current". */
  activeQuestionId?: string | null;
  /**
   * writes_to → what its response is. A responded key missing here (an
   * entity spine with rows) counts as the owner's.
   */
  responseKinds?: ReadonlyMap<string, ResponseKind>;
}

/**
 * One bar per applicable question, in bank order: the question being
 * asked, then what its current record is — the owner's, a measurement,
 * a derivation, an explicit unknown — else a skip, else open. Unknown and
 * skipped stay apart from each other and from open (rule 5).
 */
export function areaBars(
  applicable: readonly AreaQuestion[],
  responded: ReadonlySet<string>,
  skippedKeys: ReadonlySet<string>,
  activeQuestionId: string | null,
  responseKinds: ReadonlyMap<string, ResponseKind>,
): AreaBar[] {
  return [...applicable]
    .sort((a, b) => naturalIdCompare(a.id, b.id))
    .map((q): AreaBar => {
      if (q.id === activeQuestionId) return "current";
      if (responded.has(q.writes_to)) return responseKinds.get(q.writes_to) ?? "owner";
      if (skippedKeys.has(q.writes_to)) return "skipped";
      return "open";
    });
}

export function computeAreas(input: AreaInput): IntakeArea[] {
  const {
    questions,
    ctx,
    responded,
    skippedKeys,
    activeSection = null,
    activeQuestionId = null,
    responseKinds = new Map<string, ResponseKind>(),
  } = input;
  const areas: IntakeArea[] = [];
  for (const section of PROFILE_SECTIONS) {
    const inSection = questions.filter((q) => q.section === section);
    if (inSection.length === 0) continue;
    const applicable = inSection.filter((q) => q.condition === null || evaluate(q.condition, ctx));
    const answered = applicable.filter((q) => responded.has(q.writes_to)).length;
    const skipped = applicable.filter(
      (q) => !responded.has(q.writes_to) && skippedKeys.has(q.writes_to),
    ).length;
    const open = applicable.length - answered - skipped;
    const bars = areaBars(applicable, responded, skippedKeys, activeQuestionId, responseKinds);

    if (open > 0) {
      const started = answered > 0 || skipped > 0 || section === activeSection;
      areas.push({
        section,
        status: started ? "in_progress" : "not_started",
        needs: null,
        answered,
        open,
        skipped,
        bars,
      });
      continue;
    }
    if (skipped > 0) {
      // Only skips left: still the owner's to return to (rule 5 — a skip
      // is not an answer), so the area is unfinished, not done.
      areas.push({ section, status: "in_progress", needs: null, answered, open, skipped, bars });
      continue;
    }

    // Nothing to ask here right now. If some question here is waiting on
    // a fact another area records, the area needs that one first.
    const needed = new Set(
      inSection
        .flatMap((q) => (q.condition === null ? [] : unmetDependencies(q.condition, ctx)))
        .map((field) => areaOfField(field, questions))
        .filter((s): s is ProfileSection => s !== null && s !== section),
    );
    const needs = PROFILE_SECTIONS.find((s) => needed.has(s)) ?? null;
    if (needs !== null) {
      areas.push({ section, status: "blocked", needs, answered, open, skipped, bars });
      continue;
    }
    // No question applies and none is waiting: not this business's area.
    if (applicable.length === 0) continue;
    areas.push({ section, status: "completed", needs: null, answered, open, skipped, bars });
  }
  return areas;
}
