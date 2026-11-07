// The patterns API — ideas 46 and 48.
//
//   GET  /api/patterns                              the busy-season forecast from the
//                                                   business's own history, and what sells
//                                                   (or is booked) together, each pair with
//                                                   the proposal it already has this month
//   POST /api/patterns {action:"propose", key}      draft one pair as a proposal
//
// Reading needs the intake cookie; proposing needs a signed-in user (a
// proposal lands in their queue). Read-only arithmetic over measured rows:
// no model, no network. A proposal is a draft for the owner to act on —
// nothing executes it (rule 12), and no price or checkout is touched.

import { and, eq, inArray } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { db } from "../../../db";
import { proposals } from "../../../db/schema";
import { matchingSession, resolveAccess } from "../../../lib/auth/access";
import type { BundlesView } from "../../../lib/bundles/load";
import { loadBundles } from "../../../lib/bundles/load";
import { bundleRef, proposeBundle } from "../../../lib/bundles/propose";
import { careState } from "../../../lib/care/day-zero";
import { logSafeError } from "../../../lib/core/log-safe";
import { seasonClaims } from "../../../lib/forecasts/claims";
import { recordForecastsQuietly } from "../../../lib/forecasts/record";
import { dayMonthYear } from "../../../lib/i18n/format";
import type { Words } from "../../../lib/i18n/request-words";
import { requestWords } from "../../../lib/i18n/request-words";
import type { SeasonsView } from "../../../lib/seasons/load";
import { loadSeasons, seasonsInWords } from "../../../lib/seasons/load";
import { requireRole } from "../../../lib/auth/roles";

export interface PatternsView {
  seasons: SeasonsView;
  bundles: BundlesView;
  /** Pair key → the proposal it already has this month. */
  proposed: Record<string, { id: string; status: string; blocked_by_limit: string | null }>;
  /** Why proposals can't be made yet, when they can't (rule 15). */
  held: string | null;
}

/** Why proposals wait, in the reader's words; the date ISO in English, as it always was. */
function heldWords(
  care: Awaited<ReturnType<typeof careState>>,
  now: Date,
  { tr, locale }: Words,
): string | null {
  if (!care) return tr("held.choose");
  if (care.watch_ends_at && now.toISOString() < care.watch_ends_at) {
    const day = care.watch_ends_at.slice(0, 10);
    return tr("held.watching", { day: dayMonthYear(day, locale) });
  }
  return null;
}

export async function GET(): Promise<NextResponse> {
  const access = await resolveAccess();
  if (!access) return NextResponse.json({ error: "no intake session" }, { status: 401 });
  try {
    const now = new Date();
    // L-4b: the sentences go out in the reader's language; the forecast
    // recorded below is the English one (rule 7).
    const words = await requestWords("patternsWords");
    const [seasons, bundles, care] = await Promise.all([
      loadSeasons(access.account_id, access.profile_id, now),
      loadBundles(access.account_id, access.profile_id, now, words),
      careState(access.profile_id),
    ]);
    // Idea 54: the next weeks, as shown here, go on SYB's own track record
    // the first time each is shown, to be graded once the week is over.
    await recordForecastsQuietly(
      seasonClaims({ account_id: access.account_id, profile_id: access.profile_id }, seasons, now),
      {
        account_id: access.account_id,
        event: "forecasts_recorded_season",
      },
    );
    const keys = bundles.sources.flatMap((s) => s.pairs.map((p) => p.key));
    const refs = new Map(keys.map((k) => [bundleRef(k, now), k]));
    const rows =
      refs.size === 0
        ? []
        : await db
            .select({
              id: proposals.id,
              ref: proposals.originating_finding,
              status: proposals.status,
              blocked_by_limit: proposals.blocked_by_limit,
            })
            .from(proposals)
            .where(
              and(
                eq(proposals.profile_id, access.profile_id),
                inArray(proposals.originating_finding, [...refs.keys()]),
              ),
            );
    const proposed: PatternsView["proposed"] = {};
    for (const r of rows) {
      const key = r.ref ? refs.get(r.ref) : undefined;
      if (key) proposed[key] = { id: r.id, status: r.status, blocked_by_limit: r.blocked_by_limit };
    }
    const held = heldWords(care, now, words);
    return NextResponse.json({
      seasons: seasonsInWords(seasons, words),
      bundles,
      proposed,
      held,
    } satisfies PatternsView);
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "patterns_view_failed",
        account_id: access.account_id,
        ...logSafeError(error),
      }),
    );
    return NextResponse.json({ error: "something went wrong on our side" }, { status: 500 });
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const access = await resolveAccess();
  if (!access) return NextResponse.json({ error: "no intake session" }, { status: 401 });
  if (!(await matchingSession())) {
    return NextResponse.json({ error: "proposing needs you signed in" }, { status: 401 });
  }
  const denied = requireRole(access, "proposals.generate");
  if (denied) return denied;
  try {
    const body = (await request.json().catch(() => ({}))) as { action?: unknown; key?: unknown };
    if (body.action !== "propose" || typeof body.key !== "string" || body.key.length > 600) {
      return NextResponse.json(
        { error: 'action "propose" and a pair key are required' },
        { status: 422 },
      );
    }
    const run = await proposeBundle(access.profile_id, body.key);
    if ("proposal" in run) {
      return NextResponse.json(
        {
          status: run.status,
          id: run.proposal.id,
          blocked_by_limit: run.proposal.blocked_by_limit,
        },
        { status: 201 },
      );
    }
    return NextResponse.json(
      { status: run.status, error: run.reason },
      { status: run.status === "not_found" ? 404 : 409 },
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "patterns_post_failed",
        account_id: access.account_id,
        ...logSafeError(error),
      }),
    );
    return NextResponse.json({ error: "something went wrong on our side" }, { status: 500 });
  }
}
