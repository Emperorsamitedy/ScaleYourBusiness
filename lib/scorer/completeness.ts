// Completeness scorer — data-model-v1.md §8.2, step 21.
//
// Deterministic arithmetic (cost rule: no LLM for what code can do), and
// scored over the APPLICABLE question set only — a services-only business
// is not "incomplete" for inventory questions that don't exist for it.
//
// An explicit unknown COUNTS as progress everywhere: the intake asked,
// the owner answered honestly, and the gap itself is a finding (rule 5).
// Only skipped and never-asked questions hold a score down.

import type { ConditionContext } from "../conditions/evaluate";
import { VALUE_BEARING_STATUSES } from "../core/field-status";
import { isoDateTime } from "../core/iso";
import type { ISODateTime } from "../core/iso";
import type { ApplicableQuestion } from "../resolver/applicability";
import { applicableQuestions, buildConditionContext } from "../resolver/applicability";
import type { ProfileSection } from "../profile/sections";

/**
 * §8.2: core weighs heavily, optional barely at all — an owner who has
 * answered the important 25 sees a high score, not a demoralising 8%.
 */
export const PRIORITY_WEIGHTS: Readonly<Record<ApplicableQuestion["priority"], number>> = {
  core: 5,
  important: 2,
  deep: 1,
  optional: 0.1,
};

export interface CompletenessScore {
  /** 0–1, weighted by priority, over applicable questions only. */
  overall: number;
  by_section: ReadonlyMap<ProfileSection, number>;
  /** Every applicable core question answered — explicit unknown counts. */
  core_complete: boolean;
  /** writes_to of applicable core questions with no response yet. */
  blocking_gaps: string[];
  computed_at: ISODateTime;
}

/** A question's completeness input: its weight class and whether it got a response. */
export interface ScorableQuestion {
  priority: ApplicableQuestion["priority"];
  section: ProfileSection;
  writes_to: string;
  /** answered, inferred, or explicit unknown — skipped/unasked are not responses. */
  responded: boolean;
}

/** Pure core of the scorer — trivially unit-testable. */
export function scoreQuestions(
  questions: readonly ScorableQuestion[],
  computedAt: ISODateTime,
): CompletenessScore {
  let weightTotal = 0;
  let weightResponded = 0;
  const sectionTotals = new Map<ProfileSection, { total: number; responded: number }>();

  for (const q of questions) {
    const weight = PRIORITY_WEIGHTS[q.priority];
    weightTotal += weight;
    const s = sectionTotals.get(q.section) ?? { total: 0, responded: 0 };
    s.total += weight;
    if (q.responded) {
      weightResponded += weight;
      s.responded += weight;
    }
    sectionTotals.set(q.section, s);
  }

  const by_section = new Map<ProfileSection, number>();
  for (const [section, s] of sectionTotals) {
    by_section.set(section, s.total === 0 ? 1 : s.responded / s.total);
  }

  const coreGaps = questions.filter((q) => q.priority === "core" && !q.responded);

  return {
    overall: weightTotal === 0 ? 1 : weightResponded / weightTotal,
    by_section,
    core_complete: coreGaps.length === 0,
    blocking_gaps: coreGaps.map((q) => q.writes_to),
    computed_at: computedAt,
  };
}

/** A response exists when the field's status is value-bearing or explicit unknown. */
function responded(ctx: ConditionContext, writesTo: string): boolean {
  const view = ctx.get(writesTo);
  if (view === undefined) return false;
  return VALUE_BEARING_STATUSES.has(view.status) || view.status === "unknown";
}

/** Score a live profile: applicable questions × current field statuses. */
export async function computeCompleteness(profileId: string): Promise<CompletenessScore> {
  const [questions, ctx] = await Promise.all([
    applicableQuestions(profileId),
    buildConditionContext(profileId),
  ]);
  return scoreQuestions(
    questions.map((q) => ({
      priority: q.priority,
      section: q.section,
      writes_to: q.writes_to,
      responded: responded(ctx, q.writes_to),
    })),
    isoDateTime(new Date().toISOString()),
  );
}
