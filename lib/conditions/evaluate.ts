// Condition evaluator — data-model-v1.md §6.2, step 19.
//
// Branching lives in data, not code (rule 4): questions carry serializable
// ConditionExpr records and THIS is the only place they are interpreted.
// No `if (sells.includes('physical'))` exists anywhere in the app.
//
// Missing-value semantics, decided once and tested: every value
// comparison (eq, neq, includes, gt/gte/lt/lte) is FALSE when the field
// has no current value. neq deliberately means "answered and different",
// not "not known to be equal" — a follow-up must not surface before its
// upstream fact exists; the interviewer reaches it through `unlocks`
// once the upstream is answered. Only `unanswered` is true for absence.

import type { FieldStatus } from "../core/field-status";
import { VALUE_BEARING_STATUSES } from "../core/field-status";

export type ConditionExpr =
  | { op: "eq" | "neq"; field: string; value: unknown }
  | { op: "includes"; field: string; value: string }
  | { op: "gt" | "gte" | "lt" | "lte"; field: string; value: number }
  | { op: "answered" | "unanswered"; field: string }
  | { op: "and" | "or"; terms: ConditionExpr[] }
  | { op: "not"; term: ConditionExpr };

/** What the evaluator sees of one field: its status and current value. */
export interface FieldView {
  status: FieldStatus;
  value: unknown;
}

/**
 * The evaluation context. Plain field keys resolve to field views; entity
 * counts (offers.length, channels.length) resolve through the same lookup
 * by base key — the context builder (Session J) exposes entity lists as
 * array-valued views.
 */
export interface ConditionContext {
  get(fieldKey: string): FieldView | undefined;
}

export class ConditionEvalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConditionEvalError";
  }
}

/** A view has a usable value only in a value-bearing status. */
function currentValue(view: FieldView | undefined): unknown | undefined {
  if (view === undefined || !VALUE_BEARING_STATUSES.has(view.status)) return undefined;
  return view.value ?? undefined;
}

/** EnumValue values compare by their code; scalars compare as themselves. */
function unwrap(value: unknown): unknown {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const code = (value as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return value;
}

export function evaluate(expr: ConditionExpr, ctx: ConditionContext): boolean {
  switch (expr.op) {
    case "and":
      return expr.terms.every((t) => evaluate(t, ctx));
    case "or":
      return expr.terms.some((t) => evaluate(t, ctx));
    case "not":
      return !evaluate(expr.term, ctx);
    case "answered":
    case "unanswered": {
      const view = ctx.get(baseKey(expr.field));
      const has = view !== undefined && VALUE_BEARING_STATUSES.has(view.status);
      return expr.op === "answered" ? has : !has;
    }
    case "eq":
    case "neq": {
      const value = resolve(expr.field, ctx);
      if (value === undefined) return false; // see header — including neq
      const equal = unwrap(value) === unwrap(expr.value);
      return expr.op === "eq" ? equal : !equal;
    }
    case "includes": {
      const value = resolve(expr.field, ctx);
      if (value === undefined || !Array.isArray(value)) return false;
      return value.some((entry) => unwrap(entry) === expr.value);
    }
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const value = resolve(expr.field, ctx);
      if (typeof value !== "number" || Number.isNaN(value)) return false;
      if (expr.op === "gt") return value > expr.value;
      if (expr.op === "gte") return value >= expr.value;
      if (expr.op === "lt") return value < expr.value;
      return value <= expr.value;
    }
  }
}

function baseKey(fieldKey: string): string {
  return fieldKey.endsWith(".length") ? fieldKey.slice(0, -".length".length) : fieldKey;
}

/**
 * Resolve a condition field reference to a comparable value, applying the
 * `.length` accessor (P0-40): the base field must currently hold an array;
 * anything else — including a missing or valueless field — is undefined,
 * which every comparison treats as false.
 */
function resolve(fieldKey: string, ctx: ConditionContext): unknown | undefined {
  const wantsLength = fieldKey.endsWith(".length");
  const value = currentValue(ctx.get(baseKey(fieldKey)));
  if (!wantsLength) return value;
  return Array.isArray(value) ? value.length : undefined;
}
