// Candidate selection — P0-49 / step 22: cheap core before expensive deep.
//
// The tier gate is DETERMINISTIC, not a prompt suggestion: while any core
// question is open, only core questions are candidates; important opens
// when core is exhausted; deep only when nothing else remains. The model
// chooses freely WITHIN the tier (that's where conversational judgment
// lives — follow-ups, topic continuity, cost preference), but it can
// never reach a deep question early, because it never sees one. §6.1's
// sequencing promise and P0-46's core_complete gate both fall out of this.
//
// "Open" = applicable now, not yet responded (answered / inferred /
// explicit unknown), and not already asked this session — a skipped
// question stays unanswered in the profile but is never re-asked in the
// same sitting (P0-53: never repeats).

import type { ApplicableQuestion } from "../resolver/applicability";

export type Tier = "core" | "important" | "deep";

const TIER_ORDER: readonly Tier[] = ["core", "important", "deep"];

export interface CandidateSelection {
  tier: Tier | null;
  candidates: readonly ApplicableQuestion[];
  /** Open counts per tier at selection time — the harness audits these. */
  open: Readonly<Record<Tier, number>>;
}

export function selectCandidates(
  applicable: readonly ApplicableQuestion[],
  responded: ReadonlySet<string>,
  askedThisSession: ReadonlySet<string>,
): CandidateSelection {
  const openQuestions = applicable.filter(
    (q) => !askedThisSession.has(q.id) && !responded.has(q.writes_to),
  );
  const open: Record<Tier, number> = { core: 0, important: 0, deep: 0 };
  for (const q of openQuestions) {
    if (q.priority === "core" || q.priority === "important" || q.priority === "deep") {
      open[q.priority] += 1;
    }
    // "optional" exists in the type system (§6.1) but not in bank v1; an
    // optional question would never gate anything, so it rides with deep.
  }
  for (const tier of TIER_ORDER) {
    if (open[tier] > 0) {
      return {
        tier,
        candidates: openQuestions.filter((q) =>
          tier === "deep"
            ? q.priority === "deep" || q.priority === "optional"
            : q.priority === tier,
        ),
        open,
      };
    }
  }
  const optional = openQuestions.filter((q) => q.priority === "optional");
  if (optional.length > 0) return { tier: "deep", candidates: optional, open };
  return { tier: null, candidates: [], open };
}
