// The figure provenance object — the v1 build spec §6.1 (P7-31).
//
// figure { value, currency, source, source_detail, captured_at,
//          confidence (the grade A–D), depends_on }
//
// recordFigure computes the grade from provenance — never from a caller's
// say-so — and the table's trigger (migration 0101) re-checks a derived
// figure against its stored inputs, so hard rule 3 holds even for code that
// writes the table directly. A figure is never edited: a new reading is a
// new figure, and the old one keeps its place in the history.

import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../db";
import { figures } from "../../db/schema";
import type { FigureSource, Grade } from "../core/grade";
import { InvalidGradeError, provenanceGrade } from "../core/grade";
import type { Money } from "../core/money";
import { isIsoCurrency } from "../core/money";

export type Figure = typeof figures.$inferSelect;

export class FigureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FigureError";
  }
}

interface FigureBase {
  profileId: string;
  key: string;
  /** Money (integer minor units + currency, rule 1), or a count or ratio. */
  value: Money | number;
  /** Plain words: "Stripe, 2026-10-01 to 2026-10-31". */
  source_detail: string;
  captured_at: string;
}

export type FigureInput =
  | (FigureBase & {
      provenance: { source: Exclude<FigureSource, "derived">; cross_checked?: boolean };
      /** measured + cross_checked: the second measured figure that agrees. */
      cross_check_id?: string;
      derived?: never;
    })
  | (FigureBase & {
      /** A derived figure: its inputs, the formula, and whether it models. */
      derived: { from: readonly string[]; method: string; modelled?: boolean };
      provenance?: never;
      cross_check_id?: never;
    });

function valueColumns(value: Money | number): { value: string; currency: string | null } {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new FigureError("a figure's value must be a finite number");
    return { value: String(value), currency: null };
  }
  if (!Number.isSafeInteger(value.amount_minor)) {
    throw new FigureError("money is whole minor units (rule 1)");
  }
  if (!isIsoCurrency(value.currency)) throw new FigureError("money needs its ISO currency");
  return { value: String(value.amount_minor), currency: value.currency };
}

/** Record one figure, graded from its provenance (§6.1, hard rule 3). */
export async function recordFigure(input: FigureInput): Promise<Figure> {
  const columns = valueColumns(input.value);
  if (input.key.trim() === "") throw new FigureError("a figure names what it is");
  if (input.source_detail.trim() === "") {
    throw new FigureError("a figure says where it came from (source_detail)");
  }

  let grade: Grade;
  let dependsOn: string[] = [];
  if (input.derived !== undefined) {
    dependsOn = [...new Set(input.derived.from)];
    if (dependsOn.length === 0) throw new FigureError("a derived figure names its inputs");
    if (input.derived.method.trim() === "")
      throw new FigureError("a derived figure names its formula (rule 6)");
    const inputs = await db
      .select({ id: figures.id, confidence: figures.confidence })
      .from(figures)
      .where(and(inArray(figures.id, dependsOn), eq(figures.profile_id, input.profileId)));
    if (inputs.length !== dependsOn.length) {
      throw new FigureError("a derived figure can only depend on this business's own figures");
    }
    try {
      grade = provenanceGrade({
        source: "derived",
        modelled: input.derived.modelled === true,
        inputs: inputs.map((i) => i.confidence as Grade),
      });
    } catch (error) {
      if (error instanceof InvalidGradeError) throw new FigureError(error.message);
      throw error;
    }
  } else {
    const crossChecked = input.provenance.cross_checked === true;
    if (crossChecked && input.provenance.source !== "measured") {
      throw new FigureError("only a measured figure is cross-checked");
    }
    if (crossChecked !== (input.cross_check_id !== undefined)) {
      throw new FigureError(
        "a cross-checked figure names the figure that agrees with it, and only then",
      );
    }
    grade = provenanceGrade(input.provenance);
  }

  const [row] = await db
    .insert(figures)
    .values({
      profile_id: input.profileId,
      key: input.key,
      ...columns,
      source: input.derived !== undefined ? "derived" : input.provenance.source,
      source_detail: input.source_detail,
      captured_at: input.captured_at,
      confidence: grade,
      depends_on: dependsOn,
      method: input.derived?.method ?? null,
      modelled: input.derived?.modelled === true,
      cross_check_id: input.cross_check_id ?? null,
    })
    .returning();
  if (!row) throw new FigureError("the figure could not be recorded");
  return row;
}

export interface FigureTrace {
  figure: Figure;
  /** Each input with its own trace, in depends_on order. */
  inputs: FigureTrace[];
  /** The input that sets the grade (the first of the worst), or null for a source figure. */
  weakest: Figure | null;
}

/** How deep a trace follows depends_on — enough for any real derivation, never unbounded. */
const MAX_TRACE_DEPTH = 8;

/**
 * §12.1: a figure reaches its provenance record and its inputs'. Scoped to
 * the business: another business's figure id answers null, as if it didn't
 * exist.
 */
export async function traceFigure(
  profileId: string,
  figureId: string,
  depth = 0,
): Promise<FigureTrace | null> {
  const [figure] = await db
    .select()
    .from(figures)
    .where(and(eq(figures.id, figureId), eq(figures.profile_id, profileId)));
  if (!figure) return null;
  if (depth >= MAX_TRACE_DEPTH || figure.depends_on.length === 0) {
    return { figure, inputs: [], weakest: null };
  }
  const inputs: FigureTrace[] = [];
  for (const id of figure.depends_on) {
    const t = await traceFigure(profileId, id, depth + 1);
    if (t) inputs.push(t);
  }
  let weakest: Figure | null = null;
  for (const t of inputs) {
    if (weakest === null || t.figure.confidence > weakest.confidence) weakest = t.figure;
  }
  return { figure, inputs, weakest };
}
