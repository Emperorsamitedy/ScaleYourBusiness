// Performance readback — Phase 3 Session E (P3-25).
//
// Every executed proposal is confronted with what the measurement layer
// actually recorded: the mean of the business-wide daily series after
// the action, against the 28 days before it, arithmetic shown. The
// verdict vocabulary is deliberately blunt — helped, did nothing,
// backfired — plus the two honest non-verdicts: too_early (not enough
// days measured yet) and unmeasured (no connected series at all). A
// system that only ever says "helped" or "insufficient data" is hiding;
// this one can say "backfired" about its own suggestion, with numbers.
//
// Deterministic throughout: thresholds in code, tested at their
// boundaries in both directions (the anomaly-detection discipline).
//
// P3-23b: the series follows the kind. A published content item is judged
// on its own reach and interactions against the account's previous ten
// posts on that platform (post-readback.ts); an ad change on that
// campaign's return on ad spend before and after (campaign-readback.ts);
// everything else on revenue.daily, as before. The verdicts are the same
// five, so the scorecard needs no change.

import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import { businessProfiles, contentItems, executions } from "../../db/schema";
import type { ProposalRow } from "../proposals/service";
import { adPlatformOf, campaignOutcome } from "./campaign-readback";
import { emailCampaignOutcome } from "./email-readback";
import { postOutcome } from "./post-readback";
import type { WindowStat } from "./series";
import { dailySeries, shiftDay, windowStat } from "./series";
import { perUnit, ratioBp } from "../core/money";

export type { WindowStat } from "./series";

export const READBACK = {
  /** Relative change at or above this: helped. */
  helped_at: 0.05,
  /** Relative change at or below this: backfired. */
  backfired_at: -0.05,
  /** Fewer measured days after the action than this: too_early. */
  min_after_days: 7,
  /** The before-window, matching the anomaly baseline. */
  before_days: 28,
  /** The after-window cap. */
  after_days: 28,
} as const;

export type OutcomeVerdict = "helped" | "did_nothing" | "backfired" | "too_early" | "unmeasured";

/** What a proposal is judged on (P3-23b; "email" since P4-17). */
export type JudgedOn = "revenue" | "post" | "campaign" | "email";

export interface ProposalOutcome {
  proposal_id: string;
  verdict: OutcomeVerdict;
  judged_on: JudgedOn;
  executed_on: string | null;
  metric: string;
  currency: string | null;
  before: WindowStat | null;
  after: WindowStat | null;
  delta_pct: number | null;
  /** The arithmetic, with the real numbers in it — always present. */
  arithmetic: string;
  /** What the scenario promised, for the side-by-side. */
  predicted: string | null;
  assumptions: { statement: string; sensitivity: string }[];
}

function money(minor: number, currency: string | null): string {
  const major = (minor / 100).toFixed(2);
  return currency ? `${major} ${currency}` : major;
}

/** When the proposal actually ran: the engine's record, else the decision. */
export async function executedOn(proposal: ProposalRow): Promise<string | null> {
  const [execution] = await db
    .select({ finished_at: executions.finished_at })
    .from(executions)
    .where(eq(executions.proposal_id, proposal.id));
  const at = execution?.finished_at ?? proposal.decided_at;
  return at ? at.slice(0, 10) : null;
}

/** Judge one executed proposal against the measured record. */
export async function readbackForProposal(
  proposal: ProposalRow,
  now: Date = new Date(),
): Promise<ProposalOutcome> {
  const scenario = proposal.scenario as {
    base_case?: { statement?: string };
    assumptions?: { statement: string; sensitivity: string }[];
  } | null;
  const base: Omit<ProposalOutcome, "verdict" | "arithmetic"> = {
    proposal_id: proposal.id,
    judged_on: "revenue",
    executed_on: null,
    metric: "revenue.daily",
    currency: null,
    before: null,
    after: null,
    delta_pct: null,
    predicted: scenario?.base_case?.statement ?? null,
    assumptions: (scenario?.assumptions ?? []).map((a) => ({
      statement: a.statement,
      sensitivity: a.sensitivity,
    })),
  };

  const day = await executedOn(proposal);
  if (!day) {
    return { ...base, verdict: "unmeasured", arithmetic: "never executed: nothing to measure" };
  }
  base.executed_on = day;

  const kind = judgedOn(proposal);
  if (kind === "post") return publishedItemReadback(proposal, base);
  if (kind === "campaign") return adChangeReadback(proposal, base, day, now);
  if (kind === "email") return emailReadback(proposal, base);

  const from = shiftDay(day, -READBACK.before_days);
  const today = now.toISOString().slice(0, 10);
  const afterTo =
    shiftDay(day, READBACK.after_days) < today ? shiftDay(day, READBACK.after_days) : today;
  const series = await dailySeries(proposal.profile_id, "revenue.daily", from, afterTo);
  if (!series || series.values.size === 0) {
    return {
      ...base,
      verdict: "unmeasured",
      arithmetic: "no measured revenue series: connect a source and the verdict becomes possible",
    };
  }
  base.currency = series.currency;

  const before = windowStat(series, from, shiftDay(day, -1));
  const after = windowStat(series, shiftDay(day, 1), afterTo);
  base.before = before;
  base.after = after;

  if (before.days_measured === 0) {
    return {
      ...base,
      verdict: "unmeasured",
      arithmetic: "no measured days before the action: no baseline to compare against",
    };
  }
  if (after.days_measured < READBACK.min_after_days) {
    return {
      ...base,
      verdict: "too_early",
      arithmetic: `${after.days_measured} measured day(s) since ${day}: the verdict needs ${READBACK.min_after_days}`,
    };
  }

  // The change in basis points of the baseline, exact (hard rule 1); a zero baseline has none.
  const deltaBp =
    before.mean_minor === 0
      ? null
      : ratioBp(after.mean_minor - before.mean_minor, before.mean_minor);
  const tenths = deltaBp === null ? null : perUnit(deltaBp, 10);
  base.delta_pct = tenths === null ? null : tenths / 10;
  const helpedBp = Math.round(READBACK.helped_at * 10_000);
  const backfiredBp = Math.round(READBACK.backfired_at * 10_000);
  const verdict: OutcomeVerdict =
    deltaBp === null
      ? after.mean_minor > 0
        ? "helped"
        : "did_nothing"
      : deltaBp >= helpedBp
        ? "helped"
        : deltaBp <= backfiredBp
          ? "backfired"
          : "did_nothing";
  const arithmetic =
    `daily revenue averaged ${money(after.mean_minor, series.currency)} over the ` +
    `${after.days_measured} measured day(s) after ${day}, against ` +
    `${money(before.mean_minor, series.currency)} over the ${before.days_measured} before: ` +
    (base.delta_pct === null
      ? "up from none"
      : `${base.delta_pct >= 0 ? "+" : ""}${base.delta_pct}%`) +
    ` (thresholds: helped at +${READBACK.helped_at * 100}%, backfired at ${READBACK.backfired_at * 100}%)`;
  return { ...base, verdict, arithmetic };
}

type Base = Omit<ProposalOutcome, "verdict" | "arithmetic">;

interface KindDetail {
  kind?: unknown;
  detail?: {
    item_id?: unknown;
    campaign_ref?: unknown;
    campaign_name?: unknown;
    platform?: unknown;
  };
}

/** Pure: which series a proposal is judged on. */
export function judgedOn(proposal: Pick<ProposalRow, "module" | "action">): JudgedOn {
  const action = (proposal.action ?? {}) as KindDetail;
  // A per-item publish proposal (P3-21a) — the calendar shares its kind but names no item.
  if (action.kind === "content_publishing" && typeof action.detail?.item_id === "string") {
    return "post";
  }
  // A customer email campaign (P4-14/15): judged on who bought again (P4-17).
  if (proposal.module === "crm" && action.kind === "customer_email") return "email";
  // An ad change (P3-22a): module "ads", on one campaign.
  if (proposal.module === "ads" && typeof action.detail?.campaign_ref === "string") {
    return "campaign";
  }
  return "revenue";
}

async function publishedItemReadback(proposal: ProposalRow, base: Base): Promise<ProposalOutcome> {
  const itemId = (proposal.action as KindDetail).detail?.item_id as string;
  const [item] = await db
    .select({
      id: contentItems.id,
      profile_id: contentItems.profile_id,
      status: contentItems.status,
      platform: contentItems.platform,
      platform_post_id: contentItems.platform_post_id,
      published_at: contentItems.published_at,
    })
    .from(contentItems)
    .where(and(eq(contentItems.id, itemId), eq(contentItems.profile_id, proposal.profile_id)));
  const metric = item?.platform === "facebook" ? "content.views.daily" : "content.reach.daily";
  if (!item) {
    return {
      ...base,
      judged_on: "post",
      metric,
      verdict: "unmeasured",
      arithmetic: "the published item is not on record: nothing to measure",
    };
  }
  const post = await postOutcome(item);
  return {
    ...base,
    judged_on: "post",
    metric,
    verdict: post.verdict,
    delta_pct: post.delta_pct,
    arithmetic: post.arithmetic,
  };
}

async function emailReadback(proposal: ProposalRow, base: Base): Promise<ProposalOutcome> {
  const e = await emailCampaignOutcome(proposal);
  return {
    ...base,
    judged_on: "email",
    metric: "customers.bought_again",
    verdict: e.verdict,
    // Points, not a percentage change: the lift lives in the arithmetic.
    delta_pct: null,
    arithmetic: e.arithmetic,
  };
}

async function adChangeReadback(
  proposal: ProposalRow,
  base: Base,
  day: string,
  now: Date,
): Promise<ProposalOutcome> {
  const detail = (proposal.action as KindDetail).detail ?? {};
  const ref = detail.campaign_ref as string;
  const name = typeof detail.campaign_name === "string" ? detail.campaign_name : ref;
  const [profile] = await db
    .select({ account_id: businessProfiles.account_id })
    .from(businessProfiles)
    .where(eq(businessProfiles.id, proposal.profile_id));
  const metric = "roas.campaign";
  if (!profile) {
    return {
      ...base,
      judged_on: "campaign",
      metric,
      verdict: "unmeasured",
      arithmetic: "no business for this proposal",
    };
  }
  const c = await campaignOutcome({
    accountId: profile.account_id,
    campaignRef: ref,
    campaignName: name,
    changedOn: day,
    now,
    platform: adPlatformOf(detail.platform),
  });
  return {
    ...base,
    judged_on: "campaign",
    metric,
    currency: c.currency,
    verdict: c.verdict,
    delta_pct: c.delta_pct,
    arithmetic: c.arithmetic,
  };
}
