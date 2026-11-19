// A content push ahead of a busy stretch — I-46a (decided 2026-11-04,
// owner: "Propose a content push").
//
// The season forecast (lib/seasons, idea 46) reads the business's own
// measured weeks and names the busy stretches of last year that come round
// again in the next eight weeks. When one of them starts two to three weeks
// from now, this raises ONE content-calendar proposal for it, through the
// existing calendar path (./plan proposeContentPlan, kind
// "content_publishing", module "content"): the same channels-you-already-run
// rule, the same hard-limit check (rule 14), the same queue card, and
// nothing drafted or published before the owner says yes (rule 12).
//
// Deterministic, no model to decide: the stretch is the forecast's own
// arithmetic, and the timing is the window below. The gates, in order:
//
//   · not before the business is in care, nor while it is watched (rule 15);
//   · a stretch is pushed only when it starts SEASON_PUSH.lead_min_weeks to
//     lead_max_weeks weeks from this Monday, and isn't already under way;
//   · once per stretch: the ref is the stretch's first day this year, a
//     unique index holds it against a racing run, and a stretch whose start
//     moved by a week when re-read (the normal week shifts as weeks pass) is
//     still the same stretch;
//   · not when the owner has declined calendars enough to silence the kind
//     (P3-28 suppression);
//   · not without a channel the calendar can plan onto ("not set up"), and
//     not while another calendar already waits in the queue.
//
// The weekly beat (app/api/cron/weekly-watch, Mondays) runs it for every
// business in care. The stock half of I-46a is P5-04's (lib/stock).

import { and, eq, like } from "drizzle-orm";
import { db } from "../../db";
import { businessProfiles, modeDecisions, proposals } from "../../db/schema";
import { careState } from "../care/day-zero";
import { watchingUntil } from "../care/watch-words";
import { shortDate } from "../charts/model";
import { logSafeError } from "../core/log-safe";
import type { LimitLlm } from "../proposals/hard-limits";
import type { ProposalRow } from "../proposals/service";
import type { SeasonResult, Upcoming } from "../seasons/forecast";
import { addDays, times } from "../seasons/forecast";
import type { SeasonsView } from "../seasons/load";
import { loadSeasons } from "../seasons/load";
import { suppressedKinds } from "../trust/suppression";
import type { PlanOccasion } from "./plan";
import { ContentError, proposeContentPlan } from "./plan";

export const SEASON_PUSH = {
  /** The push is raised when the busy stretch starts this many weeks from this Monday, at the latest… */
  lead_min_weeks: 2,
  /** …and at the earliest. Two weeks wide, so one missed weekly run still catches it. */
  lead_max_weeks: 3,
  /** Two stretch starts this close are one stretch, re-read a week later. */
  same_within_days: 21,
} as const;

const KIND = "content_publishing";
const REF_PREFIX = "season:content:";
/** The partial unique index on proposals (migration 0081). */
const SEASON_FINDING_INDEX = "proposals_season_finding_idx";

/** Pure: the busy stretch to push for now, or null. */
export function stretchToPush(result: SeasonResult): Upcoming | null {
  if (result.status !== "ready") return null;
  return (
    result.upcoming.find(
      (u) =>
        u.run.kind === "busy" &&
        !u.in_progress &&
        u.starts_in_weeks >= SEASON_PUSH.lead_min_weeks &&
        u.starts_in_weeks <= SEASON_PUSH.lead_max_weeks,
    ) ?? null
  );
}

/** The ref a push is deduped by: the stretch's first day this year. */
export function seasonPushRef(u: Pick<Upcoming, "starts_on">): string {
  return `${REF_PREFIX}${u.starts_on}`;
}

/** Pure: whether an earlier push's ref is this stretch (its start within three weeks). */
export function sameStretch(ref: string, startsOn: string): boolean {
  if (!ref.startsWith(REF_PREFIX)) return false;
  const day = ref.slice(REF_PREFIX.length);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const lo = addDays(startsOn, -SEASON_PUSH.same_within_days);
  const hi = addDays(startsOn, SEASON_PUSH.same_within_days);
  return day >= lo && day <= hi;
}

/**
 * Pure: the calendar's occasion — its ref, its lead, the assumption it
 * rests on and the stretch's figures. Stored English (rule 7).
 */
export function seasonOccasion(
  u: Upcoming,
  series: { noun: string; source: string },
): PlanOccasion {
  const range =
    u.run.high === null
      ? ""
      : ` (your middle half of weeks: ${times(u.run.low)} to ${times(u.run.high)})`;
  return {
    ref: seasonPushRef(u),
    lead: `Ahead of your busy weeks from ${shortDate(u.starts_on)}`,
    assumption: {
      statement: `Last year the same ${u.run.weeks} weeks ran ${times(u.run.index)} your normal week${range}; this year they start on ${shortDate(u.starts_on)}, in ${u.starts_in_weeks} weeks`,
      value: null,
      source_field: null,
      measured: `your own ${series.noun}, measured from ${series.source}`,
      sensitivity: "high",
    },
    detail: {
      starts_on: u.starts_on,
      ends_on: u.ends_on,
      starts_in_weeks: u.starts_in_weeks,
      last_year: { start: u.run.start, end: u.run.end, weeks: u.run.weeks },
      index: u.run.index,
      low: u.run.low,
      high: u.run.high,
      series: { noun: series.noun, source: series.source },
      why: `Raised ${u.starts_in_weeks} weeks ahead, so posts are out before the busy weeks and run into the first of them. One year of your own history is one example: it says what happened last year, not what will.`,
    },
  };
}

export type SeasonPushOutcome =
  | { status: "created" | "blocked"; proposal: ProposalRow; ref: string }
  | {
      status:
        "held" | "no_stretch" | "already" | "suppressed" | "not_set_up" | "waiting" | "not_found";
      reason: string;
    };

function isUniqueViolation(error: unknown): boolean {
  const e = (error as { cause?: { constraint?: string }; constraint?: string }) ?? {};
  return (e.cause?.constraint ?? e.constraint) === SEASON_FINDING_INDEX;
}

/**
 * Propose a content push for the busy stretch two to three weeks out, if
 * there is one and every gate is open. Honest about every skip.
 */
export async function proposeSeasonPush(
  profileId: string,
  opts: { now?: Date; view?: SeasonsView; limitLlm?: LimitLlm } = {},
): Promise<SeasonPushOutcome> {
  const now = opts.now ?? new Date();
  const [profile] = await db
    .select({ account_id: businessProfiles.account_id })
    .from(businessProfiles)
    .where(eq(businessProfiles.id, profileId));
  if (!profile) return { status: "not_found", reason: "no such business" };

  const care = await careState(profileId);
  if (!care) return { status: "held", reason: "not in care yet: no mode decision" };
  if (care.watch_ends_at && now.toISOString() < care.watch_ends_at) {
    return { status: "held", reason: watchingUntil(care.watch_ends_at) };
  }

  const view = opts.view ?? (await loadSeasons(profile.account_id, profileId, now));
  const stretch = stretchToPush(view.result);
  if (!stretch || view.result.status !== "ready") {
    return {
      status: "no_stretch",
      reason: `no busy stretch starts ${SEASON_PUSH.lead_min_weeks} to ${SEASON_PUSH.lead_max_weeks} weeks from now`,
    };
  }

  const ref = seasonPushRef(stretch);
  const earlier = await db
    .select({ ref: proposals.originating_finding })
    .from(proposals)
    .where(
      and(
        eq(proposals.profile_id, profileId),
        like(proposals.originating_finding, `${REF_PREFIX}%`),
      ),
    );
  if (earlier.some((p) => p.ref !== null && sameStretch(p.ref, stretch.starts_on))) {
    return { status: "already", reason: "already proposed for this busy stretch" };
  }

  const silenced = (await suppressedKinds(profileId)).get(KIND);
  if (silenced) {
    return {
      status: "suppressed",
      reason: `you've declined content calendars ${silenced.rejections} times: I've stopped proposing them`,
    };
  }

  let proposal: ProposalRow;
  try {
    proposal = await proposeContentPlan(profileId, {
      weeks: stretch.starts_in_weeks,
      now,
      ...(opts.limitLlm ? { limitLlm: opts.limitLlm } : {}),
      occasion: seasonOccasion(stretch, view.result.series),
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      return { status: "already", reason: "already proposed for this busy stretch" };
    }
    if (error instanceof ContentError) {
      return {
        status: error.status === 422 ? "not_set_up" : "waiting",
        reason: error.message,
      };
    }
    throw error;
  }
  const status = proposal.status === "blocked" ? "blocked" : "created";
  console.log(
    JSON.stringify({
      event: "season_content_push",
      account_id: profile.account_id,
      profile_id: profileId,
      ref,
      status,
    }),
  );
  return { status, proposal, ref };
}

/** The weekly beat: every business in care. One business's failure doesn't stop the rest. */
export async function runSeasonPushes(
  now: Date = new Date(),
  opts: { limitLlm?: LimitLlm } = {},
): Promise<{ created: number; blocked: number; failed: number }> {
  const inCare = await db
    .selectDistinct({ profile_id: modeDecisions.profile_id })
    .from(modeDecisions);
  let created = 0;
  let blocked = 0;
  let failed = 0;
  for (const { profile_id } of inCare) {
    try {
      const out = await proposeSeasonPush(profile_id, { now, ...opts });
      if (out.status === "created") created++;
      if (out.status === "blocked") blocked++;
    } catch (error) {
      failed++;
      console.error(
        JSON.stringify({ event: "season_push_failed", profile_id, ...logSafeError(error) }),
      );
    }
  }
  return { created, blocked, failed };
}
