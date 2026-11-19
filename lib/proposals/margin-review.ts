// A margin review, as a proposal — I-44a (decided 2026-11-03, owner: "both").
//
// When the operating margin sits far under Eurostat's figure for similar
// businesses (lib/benchmarks/gap: like for like, and at least 10 points
// under), the owner may ask for it on /benchmarks; this drafts ONE proposal
// through the existing path, and nothing else:
//
//   · nothing before the business is in care, or while it is watched
//     (rule 15), the same hold as every proposal kind;
//   · the kind is the existing internal `operations_change` ("purely
//     internal process": a review of the business's own prices and costs),
//     so suppression (P3-28) and the owner's standing rules (rule 14) apply
//     to it as to every operations change;
//   · createProposal writes it with its decision-log entry (rule 7);
//   · once per calendar month.
//
// It is a DRAFT for the owner to act on. There is no executor for module
// "benchmarks", so an approval is recorded (rule 12) and left for the
// owner: no price, cost, listing or checkout is written (rule 18), and
// nothing reaches any outside service. It points at What-if pricing
// (I-43), which works out a price change's break-even from the owner's own
// figures, and the costs list.

import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import { businessProfiles, proposals } from "../../db/schema";
import { gapBasis } from "../benchmarks/gap";
import type { LargeGap } from "../benchmarks/gap";
import { currentGap } from "../benchmarks/gap-read";
import { careState } from "../care/day-zero";
import { watchingUntil } from "../care/watch-words";
import type { ActionKind, LimitLlm } from "./hard-limits";
import { checkHardLimits, ensureHardLimits, limitCaption, liveLimitLlm } from "./hard-limits";
import type { ProposalRow } from "./service";
import { createProposal } from "./service";
import { suppressedKinds } from "../trust/suppression";

export const MARGIN_REVIEW_MODULE = "benchmarks";
export const MARGIN_REVIEW_KIND: ActionKind = "operations_change";
/** Where the owner tries a price change against their own break-even (I-43). */
export const WHAT_IF_PRICING = "/simulate?tab=pricing";
const EXPIRY_DAYS = 14;

export type MarginReviewOutcome =
  | { status: "created" | "blocked"; proposal: ProposalRow }
  | { status: "held" | "no_gap" | "already" | "suppressed" | "not_found"; reason: string };

/** The ref a margin review is deduped by: once per calendar month. */
export function marginReviewRef(now: Date): string {
  return `benchmark:operating_margin:${now.toISOString().slice(0, 7)}`;
}

const points = (g: LargeGap) => `${g.points.toFixed(1)} points`;

/** Pure: the proposal's evidence lines, every one from the gap's own figures. */
export function marginReviewEvidence(g: LargeGap): string[] {
  return [
    `your operating margin works out at ${g.own_pct.toFixed(1)}%, from ${g.inputs.map((i) => `${i.label.toLowerCase()} (${i.basis})`).join(", ")}`,
    `Eurostat's figure for ${g.cell.words} is ${g.bench_pct.toFixed(1)}%`,
    `${points(g)} under it; a gap is called large at ${g.threshold_points} points or more`,
    ...(g.left_out.length > 0 ? [`left out of your margin: ${g.left_out.join(" ")}`] : []),
  ];
}

export async function proposeMarginReview(
  profileId: string,
  opts: { now?: Date; limitLlm?: LimitLlm } = {},
): Promise<MarginReviewOutcome> {
  const now = opts.now ?? new Date();
  const [profile] = await db
    .select({ account_id: businessProfiles.account_id })
    .from(businessProfiles)
    .where(eq(businessProfiles.id, profileId));
  if (!profile) return { status: "not_found", reason: "no such business" };

  const care = await careState(profileId);
  if (!care) {
    return { status: "held", reason: "I propose once you've chosen how I work for you." };
  }
  if (care.watch_ends_at && now.toISOString() < care.watch_ends_at) {
    return { status: "held", reason: watchingUntil(care.watch_ends_at) };
  }

  const gap = await currentGap(profileId, now);
  if (!gap) {
    return {
      status: "no_gap",
      reason: "your margin isn't far enough under similar businesses' to propose a review",
    };
  }

  const ref = marginReviewRef(now);
  const [existing] = await db
    .select({ id: proposals.id })
    .from(proposals)
    .where(and(eq(proposals.profile_id, profileId), eq(proposals.originating_finding, ref)));
  if (existing) return { status: "already", reason: "already proposed this month" };

  const silenced = (await suppressedKinds(profileId)).get(MARGIN_REVIEW_KIND);
  if (silenced) {
    return {
      status: "suppressed",
      reason: `you've declined operations changes ${silenced.rejections} times: I've stopped proposing them`,
    };
  }

  const limits = (await ensureHardLimits(profileId, opts.limitLlm ?? liveLimitLlm)).limits;
  const verdict = checkHardLimits(limits, MARGIN_REVIEW_KIND);
  const evidence = marginReviewEvidence(gap);
  const row = await createProposal({
    profile_id: profileId,
    module: MARGIN_REVIEW_MODULE,
    originating_finding: ref,
    action: {
      kind: MARGIN_REVIEW_KIND,
      summary: `Review your prices and costs: your operating margin is ${points(gap)} under similar businesses'`,
      detail: {
        what: `Go through your prices and your largest costs, one by one, against what they earn. Try any price change in What-if pricing first (${WHAT_IF_PRICING}): it works out the break-even from your own price, cost and volume.`,
        gap: {
          line: gap.line,
          own_pct: gap.own_pct,
          bench_pct: gap.bench_pct,
          points: gap.points,
          threshold_points: gap.threshold_points,
          cell: gap.cell,
          source: gap.source,
          derived_from: gap.derived_from,
        },
        basis: gapBasis(gap),
        evidence,
        draft_only: true,
        sending:
          "Approving records your yes. I change nothing: no price, cost or listing is written anywhere. Any change is yours to make.",
        links: { what_if_pricing: WHAT_IF_PRICING, costs: "/intake?ask=5.1" },
        manual_limits: verdict.manual.map((l) => l.quote),
      },
    },
    scenario: {
      assumptions: [
        ...evidence.map((statement) => ({
          statement,
          value: null,
          source_field: null,
          measured: `Eurostat ${gap.source.dataset}, updated ${gap.source.updated}`,
          sensitivity: "low" as const,
        })),
        {
          statement:
            "Eurostat's figure is a ratio of totals across the whole group, not a typical business; how much of the gap is closable is not known until you've looked",
          value: null,
          source_field: null,
          sensitivity: "high" as const,
        },
      ],
      base_case: {
        case: "base",
        statement:
          "The review finds a price that is low against its cost, or a cost that has grown, and you change it yourself.",
        profit_delta_monthly: null,
        formula: null,
      },
      downside_case: {
        case: "downside",
        statement:
          "Nothing changes: the gap is how your business is built (your own pay on the costs list, say), and you've spent the time looking.",
        profit_delta_monthly: null,
        formula: null,
      },
      upside_case: {
        case: "upside",
        statement: `Each point of margin regained is a point of every sale kept; the gap is ${points(gap)}.`,
        profit_delta_monthly: null,
        formula: gap.formula,
      },
      breakeven_condition: "nothing to break even on: a review changes nothing by itself",
    },
    reversibility: {
      level: "easy",
      if_you_change_your_mind: "Nothing to undo: a review changes nothing by itself.",
    },
    expires_at: new Date(now.getTime() + EXPIRY_DAYS * 86_400_000).toISOString(),
    blocked_by_limit: verdict.verdict === "blocked" ? limitCaption(verdict.limit) : null,
  });
  console.log(
    JSON.stringify({
      event: "margin_review_proposal",
      profile_id: profileId,
      account_id: profile.account_id,
      ref,
      status: verdict.verdict === "blocked" ? "blocked" : "created",
    }),
  );
  return { status: verdict.verdict === "blocked" ? "blocked" : "created", proposal: row };
}
