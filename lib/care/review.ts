// The alert review and escalation — P3-46/47 (Session J, alert mode).
//
// When a goal reaches alert (P3-44), one Opus call reads the case file
// (P3-45) and answers three things: what most likely went wrong, which
// causes it weighed and set aside, and what to try next. The rules that
// keep that judgement honest are enforced in CODE, after the answer, the
// diagnosis report's own discipline (P1-24):
//
//   · a cause with no evidence, or citing an id the case file does not
//     hold, is REJECTED — kept visible, never repaired
//   · every cause category must be either named or explicitly set aside,
//     including "our advice was wrong" and "the goal was unrealistic":
//     the review may blame us, and it may not skip the question
//   · suggestions become proposals in the normal queue (rule 12), through
//     the owner's hard limits (rule 14) and decline-suppression (P3-28).
//     Nothing executes; no limit is relaxed; no goal is lowered by code.
//
// P3-47: one review per goal per alert episode. If the goal is still in
// alert when the recovery window closes — or the review was unusable, or
// the account's review budget is spent — the case goes to a person on
// /ops and the owner is told so. No second automatic review until that
// person resolves it: no AI loop.

import { and, desc, eq, gte, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "../../db";
import { alertReviews, businessProfiles, llmCalls, watchActivity } from "../../db/schema";
import { readAnswer } from "../llm/answer";
import { opusShape } from "../llm/models";
import { anthropicClient } from "../llm/client";
import type { LlmCallRecord } from "../llm/cost-log";
import { buildCallRecord, recordLlmCall } from "../llm/cost-log";
import { PROPOSAL_EXPIRY_DAYS } from "../proposals/generate";
import type { ActionKind, LimitLlm } from "../proposals/hard-limits";
import {
  ACTION_KINDS,
  checkHardLimits,
  ensureHardLimits,
  limitCaption,
  liveLimitLlm,
} from "../proposals/hard-limits";
import { createProposal } from "../proposals/service";
import { suppressedKinds } from "../trust/suppression";
import type { CaseFile } from "./case-file";
import { buildCaseFile, renderCaseFile } from "./case-file";

export const REVIEW = {
  /** At most one automatic review per goal in this many days. */
  min_days_between_reviews: 56,
  /** Still in alert this long after a review: a person takes over. */
  recovery_window_days: 42,
  /** Per account per calendar month (UTC); spent = straight to a person. */
  monthly_cap_eur: 3,
  max_tokens: 8_000,
} as const;

export const REVIEW_WORKLOAD = "alert_review";
export const REVIEW_MODULE = "alert_review";

export const CAUSE_CATEGORIES = [
  "our_advice_was_wrong",
  "goal_unrealistic",
  "owner_declined_key_actions",
  "approved_actions_not_executed",
  "execution_failed",
  "data_incomplete",
  "external_change",
  "other",
] as const;
export type CauseCategory = (typeof CAUSE_CATEGORIES)[number];

/** Not proposal kinds: no executor runs them, so they stay suggestions for the owner. */
export const OWNER_ONLY_SUGGESTIONS = ["revise_goal", "stop_strategy"] as const;
const SUGGESTION_KINDS = [...ACTION_KINDS, ...OWNER_ONLY_SUGGESTIONS] as const;

export interface ReviewCause {
  category: CauseCategory;
  statement: string;
  evidence: string[];
  confidence: number;
}

export interface ReviewSuggestion {
  kind: (typeof SUGGESTION_KINDS)[number];
  title: string;
  rationale: string;
  evidence: string[];
  /** Set when it went into the queue; the reason when it did not. */
  proposal_id: string | null;
  note: string | null;
}

export interface AlertReview {
  summary: string;
  causes: ReviewCause[];
  considered: { category: CauseCategory; why_not: string }[];
  suggestions: ReviewSuggestion[];
}

export interface Rejected {
  raw: unknown;
  reason: string;
}

const OUTPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    summary: { type: "string" as const },
    causes: {
      type: "array" as const,
      items: {
        type: "object" as const,
        properties: {
          category: { type: "string" as const, enum: [...CAUSE_CATEGORIES] },
          statement: { type: "string" as const },
          evidence: { type: "array" as const, items: { type: "string" as const } },
          confidence: { type: "number" as const },
        },
        required: ["category", "statement", "evidence", "confidence"],
        additionalProperties: false,
      },
    },
    considered: {
      type: "array" as const,
      items: {
        type: "object" as const,
        properties: {
          category: { type: "string" as const, enum: [...CAUSE_CATEGORIES] },
          why_not: { type: "string" as const },
        },
        required: ["category", "why_not"],
        additionalProperties: false,
      },
    },
    suggestions: {
      type: "array" as const,
      items: {
        type: "object" as const,
        properties: {
          kind: { type: "string" as const, enum: [...SUGGESTION_KINDS] },
          title: { type: "string" as const },
          rationale: { type: "string" as const },
          evidence: { type: "array" as const, items: { type: "string" as const } },
        },
        required: ["kind", "title", "rationale", "evidence"],
        additionalProperties: false,
      },
    },
  },
  required: ["summary", "causes", "considered", "suggestions"],
  additionalProperties: false,
};

// PROMPT STATUS: UNCALIBRATED — written 2026-10-13, never run against a
// real stalled business. Calibrate on the first real alert, as the
// diagnosis prompt was (findings.ts header).
export const REVIEW_SYSTEM = `A small business has been in SYB's care and is not moving towards its owner's goal. You are reviewing everything that happened, to find out why and what to try next.

You are given a case file. Every line starts with an evidence id in square brackets. Rules that code checks after you answer — violating them discards that part of your answer:
- causes: each names a category, states the cause plainly, and cites evidence ids copied EXACTLY from the case file. A cause with no evidence, or citing an id that is not in the case file, is discarded.
- Weigh every category: ${CAUSE_CATEGORIES.join(", ")}. Each must appear either as a cause or in "considered" with the reason you set it aside. A skipped category is recorded as a failure of this review.
- "our_advice_was_wrong" is SYB's own suggestions failing — proposals that executed and did nothing or backfired. Name it when the evidence says so. Protecting the product is not your job; finding the truth is.
- "goal_unrealistic" is the target asking for more than the business could plausibly do in the time. Say so when the evidence says so.
- Never invent numbers. Use the case file's figures.
- suggestions: 1 to 4 concrete next steps, each citing evidence ids. Use an action kind when one fits; "revise_goal" and "stop_strategy" are suggestions the owner acts on. Do not suggest anything the case file shows the owner has refused or limited.
- summary: at most five sentences, plain language, addressed to the owner as "you": what we tried, what happened, what we think went wrong, what we suggest now.`;

export type ReviewLlm = (args: {
  system: string;
  user: string;
  accountId: string;
}) => Promise<{ text: string; calls: LlmCallRecord[] }>;

// One call per review with a short system prompt and a case file that is
// different every time: nothing repeats, so there is no prefix for prompt
// caching to reuse (amended at build — P3-46's "the prompt is cached").
export const liveReviewLlm: ReviewLlm = async ({ system, user, accountId }) => {
  const started = Date.now();
  // DIAGNOSIS_MODEL: Opus 4.8 exactly as today; Opus 5.5 with an explicit
  // effort and room for its thinking (lib/llm/models.ts says why).
  const shape = opusShape(REVIEW.max_tokens);
  const format = { type: "json_schema" as const, schema: OUTPUT_SCHEMA };
  const response = await anthropicClient().messages.create({
    model: shape.model,
    max_tokens: shape.max_tokens,
    thinking: shape.thinking,
    system,
    output_config: { ...shape.effort, format },
    messages: [{ role: "user", content: user }],
  });
  const record = buildCallRecord({
    workload: REVIEW_WORKLOAD,
    account_id: accountId,
    model: shape.model,
    duration_ms: Date.now() - started,
    usage: {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
      cache_creation_input_tokens: response.usage.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: response.usage.cache_read_input_tokens ?? 0,
    },
  });
  await recordLlmCall(record);
  // Refusal first (logged), never parsed: a declined review comes back as
  // no text, which the run records as unusable and hands to a person.
  const { text } = readAnswer(response, record);
  return { text, calls: [record] };
};

const isCategory = (v: unknown): v is CauseCategory =>
  typeof v === "string" && (CAUSE_CATEGORIES as readonly string[]).includes(v);
const isStrings = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string");

/** The code, not the prompt, decides what survives. Exported for tests. */
export function validateReview(
  raw: unknown,
  knownIds: ReadonlySet<string>,
): {
  review: Omit<AlertReview, "suggestions"> & {
    suggestions: Omit<ReviewSuggestion, "proposal_id" | "note">[];
  };
  rejected: Rejected[];
} {
  const rejected: Rejected[] = [];
  const body = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const unknownIds = (ids: string[]) => ids.filter((id) => !knownIds.has(id));

  const causes: ReviewCause[] = [];
  for (const item of Array.isArray(body.causes) ? body.causes : []) {
    const c = item as Partial<ReviewCause>;
    if (!isCategory(c.category)) {
      rejected.push({ raw: item, reason: "unknown cause category" });
    } else if (typeof c.statement !== "string" || c.statement.trim() === "") {
      rejected.push({ raw: item, reason: "a cause needs a statement" });
    } else if (!isStrings(c.evidence) || c.evidence.length === 0) {
      rejected.push({ raw: item, reason: "a cause without evidence is not stated" });
    } else if (unknownIds(c.evidence).length > 0) {
      rejected.push({
        raw: item,
        reason: `cites evidence the case file does not hold: ${unknownIds(c.evidence).join(", ")}`,
      });
    } else {
      const confidence = typeof c.confidence === "number" ? c.confidence : 0;
      causes.push({
        category: c.category,
        statement: c.statement.trim(),
        evidence: c.evidence,
        confidence: Math.min(1, Math.max(0, confidence)),
      });
    }
  }

  const considered: AlertReview["considered"] = [];
  for (const item of Array.isArray(body.considered) ? body.considered : []) {
    const c = item as { category?: unknown; why_not?: unknown };
    if (isCategory(c.category) && typeof c.why_not === "string" && c.why_not.trim() !== "") {
      considered.push({ category: c.category, why_not: c.why_not.trim() });
    } else {
      rejected.push({ raw: item, reason: "a set-aside category needs its category and reason" });
    }
  }

  const weighed = new Set([...causes.map((c) => c.category), ...considered.map((c) => c.category)]);
  for (const category of CAUSE_CATEGORIES) {
    if (!weighed.has(category)) {
      rejected.push({ raw: category, reason: `category not weighed: ${category}` });
    }
  }

  const suggestions: Omit<ReviewSuggestion, "proposal_id" | "note">[] = [];
  for (const item of Array.isArray(body.suggestions) ? body.suggestions : []) {
    const s = item as Partial<ReviewSuggestion>;
    if (typeof s.kind !== "string" || !(SUGGESTION_KINDS as readonly string[]).includes(s.kind)) {
      rejected.push({ raw: item, reason: "unknown suggestion kind" });
    } else if (typeof s.title !== "string" || s.title.trim() === "") {
      rejected.push({ raw: item, reason: "a suggestion needs a title" });
    } else if (
      !isStrings(s.evidence) ||
      s.evidence.length === 0 ||
      unknownIds(s.evidence).length > 0
    ) {
      rejected.push({ raw: item, reason: "a suggestion must cite evidence the case file holds" });
    } else {
      suggestions.push({
        kind: s.kind as ReviewSuggestion["kind"],
        title: s.title.trim(),
        rationale: typeof s.rationale === "string" ? s.rationale.trim() : "",
        evidence: s.evidence,
      });
    }
  }

  const summary = typeof body.summary === "string" ? body.summary.trim() : "";
  return { review: { summary, causes, considered, suggestions }, rejected };
}

const REVERSIBILITY: Record<
  ActionKind,
  { level: "easy" | "moderate" | "hard"; if_you_change_your_mind: string }
> = {
  price_increase: { level: "easy", if_you_change_your_mind: "Put the price back." },
  price_decrease: { level: "easy", if_you_change_your_mind: "Put the price back." },
  discount_or_promotion: {
    level: "moderate",
    if_you_change_your_mind: "End the promotion; customers who used it keep their price.",
  },
  paid_ads_start_or_increase: {
    level: "moderate",
    if_you_change_your_mind: "Pause or lower the budget; money already spent is spent.",
  },
  paid_ads_decrease_or_pause: { level: "easy", if_you_change_your_mind: "Restore the budget." },
  content_publishing: { level: "easy", if_you_change_your_mind: "Take the post down." },
  cold_outreach: { level: "hard", if_you_change_your_mind: "A sent message cannot be unsent." },
  channel_expansion: {
    level: "moderate",
    if_you_change_your_mind: "Close the channel; setup effort is not recovered.",
  },
  offer_change: { level: "moderate", if_you_change_your_mind: "Restore the previous offer." },
  operations_change: {
    level: "easy",
    if_you_change_your_mind: "Go back to the old way of working.",
  },
  support_knowledge: { level: "easy", if_you_change_your_mind: "Retire the entry in one click." },
  customer_email: { level: "hard", if_you_change_your_mind: "A sent email cannot be unsent." },
  deal_followup: {
    level: "easy",
    if_you_change_your_mind: "Nothing is sent by me; don't send the draft.",
  },
};

function reviewScenario(rationale: string) {
  const outcome = (c: "base" | "downside" | "upside", statement: string) => ({
    case: c,
    statement,
    profit_delta_monthly: null,
    formula: null,
  });
  return {
    assumptions: [
      { statement: rationale, value: null, source_field: null, sensitivity: "high" as const },
    ],
    base_case: outcome(
      "base",
      "It addresses a cause the alert review named, and the weekly check shows movement.",
    ),
    downside_case: outcome(
      "downside",
      "It does not move the goal; the next weekly checks show that plainly.",
    ),
    upside_case: outcome("upside", "It removes the main cause and the goal returns to its path."),
    breakeven_condition:
      "not computed — the alert review proposes; the readback judges what happened",
  };
}

export type ReviewRunResult =
  | { kind: "reviewed"; review_id: string; proposals: number }
  | { kind: "unusable"; review_id: string }
  | { kind: "skipped_cost_cap"; review_id: string }
  | { kind: "escalated_already" }
  | { kind: "too_soon"; last_review_at: string };

async function monthlyReviewSpend(accountId: string, now: Date): Promise<number> {
  const monthStart = `${now.toISOString().slice(0, 7)}-01T00:00:00.000Z`;
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${llmCalls.cost_eur}), 0)` })
    .from(llmCalls)
    .where(
      and(
        eq(llmCalls.account_id, accountId),
        eq(llmCalls.workload, REVIEW_WORKLOAD),
        gte(llmCalls.at, monthStart),
      ),
    );
  return Number(row?.total ?? 0);
}

async function logWatch(profileId: string, kind: string, detail: string, meta: object, at: string) {
  await db.insert(watchActivity).values({ profile_id: profileId, at, kind, detail, meta });
}

const ESCALATED_DETAIL =
  "A person at SYB is now looking at this goal — the automatic review has done what it can.";

/** Run the review for a goal in alert. Guards first; one model call at most. */
export async function runAlertReview(
  profileId: string,
  goalId: string,
  opts: { llm?: ReviewLlm; limitLlm?: LimitLlm; now?: Date } = {},
): Promise<ReviewRunResult> {
  const now = opts.now ?? new Date();
  const at = now.toISOString();
  const [latest] = await db
    .select()
    .from(alertReviews)
    .where(and(eq(alertReviews.profile_id, profileId), eq(alertReviews.goal_id, goalId)))
    .orderBy(desc(alertReviews.created_at))
    .limit(1);
  if (latest?.escalated_at && !latest.resolved_at) return { kind: "escalated_already" };
  if (
    latest &&
    !latest.resolved_at &&
    now.getTime() - Date.parse(latest.created_at) < REVIEW.min_days_between_reviews * 86_400_000
  ) {
    return { kind: "too_soon", last_review_at: latest.created_at };
  }

  const [profile] = await db
    .select({ account_id: businessProfiles.account_id })
    .from(businessProfiles)
    .where(eq(businessProfiles.id, profileId));
  const accountId = profile?.account_id ?? profileId;
  const caseFile: CaseFile = await buildCaseFile(profileId, goalId, now);
  const reviewId = crypto.randomUUID();
  const base = {
    id: reviewId,
    profile_id: profileId,
    goal_id: goalId,
    created_at: at,
    case_file: {
      lines: caseFile.lines,
      snapshot_id: caseFile.snapshot_id,
      built_at: caseFile.built_at,
    },
    case_hash: caseFile.hash,
  };

  if ((await monthlyReviewSpend(accountId, now)) >= REVIEW.monthly_cap_eur) {
    const reason = `this month's review budget (€${REVIEW.monthly_cap_eur}) is spent`;
    await db.insert(alertReviews).values({
      ...base,
      outcome: "skipped_cost_cap",
      escalated_at: at,
      escalation_reason: reason,
    });
    await logWatch(
      profileId,
      "goal_escalated",
      ESCALATED_DETAIL,
      { goal_id: goalId, review_id: reviewId, reason },
      at,
    );
    return { kind: "skipped_cost_cap", review_id: reviewId };
  }

  const llm = opts.llm ?? liveReviewLlm;
  const { text, calls } = await llm({
    system: REVIEW_SYSTEM,
    user: renderCaseFile(caseFile),
    accountId,
  });
  const cost = calls.reduce((s, c) => s + c.cost_eur, 0);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  const { review, rejected } = validateReview(parsed, new Set(caseFile.lines.map((l) => l.id)));
  if (parsed === null)
    rejected.push({ raw: text.slice(0, 2_000), reason: "the answer was not JSON" });

  if (review.causes.length === 0 || review.summary === "") {
    const reason = "the automatic review produced no evidenced cause";
    await db.insert(alertReviews).values({
      ...base,
      outcome: "unusable",
      review,
      rejected,
      cost_eur: cost.toFixed(6),
      escalated_at: at,
      escalation_reason: reason,
    });
    await logWatch(
      profileId,
      "goal_escalated",
      ESCALATED_DETAIL,
      { goal_id: goalId, review_id: reviewId, reason },
      at,
    );
    return { kind: "unusable", review_id: reviewId };
  }

  // Suggestions into the queue — through the owner's limits and declines.
  const { limits } = await ensureHardLimits(profileId, opts.limitLlm ?? liveLimitLlm);
  const suppressed = await suppressedKinds(profileId);
  const suggestions: ReviewSuggestion[] = [];
  const proposalIds: string[] = [];
  for (const [i, s] of review.suggestions.entries()) {
    if (!(ACTION_KINDS as readonly string[]).includes(s.kind)) {
      suggestions.push({
        ...s,
        proposal_id: null,
        note: "yours to decide — nothing runs this for you",
      });
      continue;
    }
    const kind = s.kind as ActionKind;
    const suppression = suppressed.get(kind);
    if (suppression) {
      suggestions.push({
        ...s,
        proposal_id: null,
        note: `not proposed — you've declined ${kind.replace(/_/g, " ")} ${suppression.rejections} times`,
      });
      continue;
    }
    const verdict = checkHardLimits(limits, kind);
    const row = await createProposal({
      profile_id: profileId,
      module: REVIEW_MODULE,
      originating_finding: `alert_review:${reviewId}:${i}`,
      action: { kind, summary: s.title, detail: { rationale: s.rationale, evidence: s.evidence } },
      scenario: reviewScenario(s.rationale) as never,
      reversibility: REVERSIBILITY[kind],
      expires_at: new Date(now.getTime() + PROPOSAL_EXPIRY_DAYS * 86_400_000).toISOString(),
      blocked_by_limit: verdict.verdict === "blocked" ? limitCaption(verdict.limit) : null,
    });
    proposalIds.push(row.id);
    suggestions.push({
      ...s,
      proposal_id: row.id,
      note: row.status === "blocked" ? `withheld by your limit ${row.blocked_by_limit}` : null,
    });
  }

  const stored: AlertReview = { ...review, suggestions };
  await db.insert(alertReviews).values({
    ...base,
    outcome: "reviewed",
    review: stored,
    rejected,
    proposal_ids: proposalIds,
    cost_eur: cost.toFixed(6),
  });
  await logWatch(
    profileId,
    "alert_review",
    `Alert review: ${review.summary}`,
    { goal_id: goalId, review_id: reviewId, proposals: proposalIds.length },
    at,
  );
  return { kind: "reviewed", review_id: reviewId, proposals: proposalIds.length };
}

/**
 * P3-47: still in alert once the recovery window has closed → a person.
 * Called on every weekly check that finds the goal still in alert.
 */
export async function escalateIfStuck(
  profileId: string,
  goalId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const [latest] = await db
    .select()
    .from(alertReviews)
    .where(and(eq(alertReviews.profile_id, profileId), eq(alertReviews.goal_id, goalId)))
    .orderBy(desc(alertReviews.created_at))
    .limit(1);
  if (!latest || latest.escalated_at || latest.resolved_at) return false;
  const closes = Date.parse(latest.created_at) + REVIEW.recovery_window_days * 86_400_000;
  if (now.getTime() < closes) return false;
  const at = now.toISOString();
  const reason = `still in alert ${REVIEW.recovery_window_days} days after the review's recovery plan`;
  await db
    .update(alertReviews)
    .set({ escalated_at: at, escalation_reason: reason })
    .where(eq(alertReviews.id, latest.id));
  await logWatch(
    profileId,
    "goal_escalated",
    ESCALATED_DETAIL,
    { goal_id: goalId, review_id: latest.id, reason },
    at,
  );
  return true;
}

export interface Escalation {
  review_id: string;
  profile_id: string;
  goal_id: string;
  escalated_at: string;
  reason: string;
  outcome: string;
}

/** The /ops list: every case handed to a person and not yet closed. */
export async function openEscalations(): Promise<Escalation[]> {
  const rows = await db
    .select()
    .from(alertReviews)
    .where(and(isNotNull(alertReviews.escalated_at), isNull(alertReviews.resolved_at)))
    .orderBy(desc(alertReviews.escalated_at));
  return rows.map((r) => ({
    review_id: r.id,
    profile_id: r.profile_id,
    goal_id: r.goal_id,
    escalated_at: r.escalated_at as string,
    reason: r.escalation_reason ?? "",
    outcome: r.outcome,
  }));
}

/** A person closed the case. Automatic review may run again on the next alert. */
export async function resolveEscalation(reviewId: string, now: Date = new Date()): Promise<void> {
  const updated = await db
    .update(alertReviews)
    .set({ resolved_at: now.toISOString() })
    .where(and(eq(alertReviews.id, reviewId), isNull(alertReviews.resolved_at)))
    .returning({ id: alertReviews.id });
  if (updated.length === 0) throw new Error(`no open review ${reviewId}`);
}
