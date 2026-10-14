// The weekly watch job — Session H (P1-46). For every profile under an
// active watch: freeze the profile, diff it against the previous
// snapshot, and write what ACTUALLY happened to the activity log. Every
// entry corresponds to real work performed — a watch that did nothing
// says "held steady", it does not invent motion.
//
// P2-30: the same beat reads the trading-hours findings and logs them
// when the signals move — which fire, on which days — so an unchanged
// finding is said once, not every week.

import { and, desc, eq, gt, inArray } from "drizzle-orm";
import { db } from "../../db";
import { modeDecisions, watchActivity } from "../../db/schema";
import { format, money } from "../core/money";
import type { TradingHoursBlock } from "../hours/findings";
import { findingsSignature, tradingFindings } from "../hours/findings";
import type { TradingAnalysis } from "../hours/trading";
import { tradingAnalysis } from "../hours/trading";
import { diffSnapshots, ensureSnapshot, listSnapshots } from "../profile/snapshot";

export interface WatchRunResult {
  watched: number;
  snapshots_taken: number;
  completed: number;
  /** P2-30: profiles whose trading-hours findings moved and were logged. */
  hours_logged: number;
}

export const HOURS_FINDINGS_KIND = "hours_findings";

/** The one-liner the watch log shows for a set of trading-hours findings. */
export function hoursDetail(block: TradingHoursBlock, hadBefore: boolean): string {
  if (block.findings.length === 0) {
    return hadBefore
      ? "Trading hours: no signal fires any more on the measured days."
      : "Trading hours checked: no signal on any measured day.";
  }
  return `Trading hours: ${block.findings.map((f) => f.title).join("; ")}.`;
}

/**
 * Log this week's trading-hours findings when their signature differs
 * from the last one logged. Returns whether an entry was written. A
 * failure here never stops the watch: the snapshot is the job.
 */
export async function logHoursFindings(
  profileId: string,
  now: Date,
  analyse: (profileId: string, now: Date) => Promise<TradingAnalysis> = (id, at) =>
    tradingAnalysis(id, at, (m, c) => format(money(m, c))),
): Promise<boolean> {
  let block: TradingHoursBlock | null;
  try {
    block = tradingFindings(await analyse(profileId, now));
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "watch_hours_failed",
        profile_id: profileId,
        message: String(error),
      }),
    );
    return false;
  }
  if (block === null) return false;

  const [last] = await db
    .select({ meta: watchActivity.meta })
    .from(watchActivity)
    .where(
      and(eq(watchActivity.profile_id, profileId), eq(watchActivity.kind, HOURS_FINDINGS_KIND)),
    )
    .orderBy(desc(watchActivity.at))
    .limit(1);
  const signature = findingsSignature(block);
  const previous = (last?.meta as { signature?: string } | null)?.signature;
  if (last && previous === signature) return false;

  await db.insert(watchActivity).values({
    profile_id: profileId,
    kind: HOURS_FINDINGS_KIND,
    detail: hoursDetail(block, last !== undefined && previous !== ""),
    meta: { signature, ...block },
  });
  return true;
}

/** Profiles whose LATEST decision is an unexpired watch. */
async function activeWatches(): Promise<{ profile_id: string; review_at: string }[]> {
  const rows = await db
    .select({
      profile_id: modeDecisions.profile_id,
      mode: modeDecisions.mode,
      review_at: modeDecisions.review_at,
      decided_at: modeDecisions.decided_at,
    })
    .from(modeDecisions)
    .orderBy(desc(modeDecisions.decided_at));
  const latest = new Map<string, (typeof rows)[number]>();
  for (const r of rows) if (!latest.has(r.profile_id)) latest.set(r.profile_id, r);
  return [...latest.values()]
    .filter((r) => r.mode === "watching")
    .map((r) => ({ profile_id: r.profile_id, review_at: r.review_at }));
}

export async function runWeeklyWatch(now = new Date()): Promise<WatchRunResult> {
  const watches = await activeWatches();
  let snapshots = 0;
  let completed = 0;
  let hoursLogged = 0;

  for (const watch of watches) {
    if (Date.parse(watch.review_at) <= now.getTime()) {
      // The watch has run its course. Say so once.
      const [already] = await db
        .select({ id: watchActivity.id })
        .from(watchActivity)
        .where(
          and(
            eq(watchActivity.profile_id, watch.profile_id),
            eq(watchActivity.kind, "watch_complete"),
            gt(watchActivity.at, watch.review_at),
          ),
        )
        .limit(1);
      if (!already) {
        await db.insert(watchActivity).values({
          profile_id: watch.profile_id,
          kind: "watch_complete",
          detail: "The watch period is complete. The next report reads everything gathered.",
        });
        completed++;
      }
      continue;
    }

    if (await logHoursFindings(watch.profile_id, now)) hoursLogged++;

    const before = await listSnapshots(watch.profile_id);
    const summary = await ensureSnapshot(watch.profile_id, "watching_weekly");
    const isNew = !before.some((s) => s.id === summary.id);
    snapshots += isNew ? 1 : 0;

    if (!isNew || before.length === 0) {
      await db.insert(watchActivity).values({
        profile_id: watch.profile_id,
        kind: "snapshot_taken",
        detail:
          before.length === 0
            ? `Baseline snapshot recorded: ${summary.fact_count} facts.`
            : "Weekly check: the profile held steady — nothing changed since last week.",
        meta: { snapshot_id: summary.id },
      });
      continue;
    }

    const previous = before[0];
    if (!previous) continue;
    const diff = await diffSnapshots(previous.id, summary.id);
    const parts: string[] = [];
    if (diff.changed.length > 0) parts.push(`${diff.changed.length} changed`);
    if (diff.added.length > 0) parts.push(`${diff.added.length} new`);
    if (diff.removed.length > 0) parts.push(`${diff.removed.length} removed`);
    await db.insert(watchActivity).values({
      profile_id: watch.profile_id,
      kind: "diff_computed",
      detail: `Weekly snapshot: ${parts.join(", ") || "no field movement"} since last week.`,
      meta: {
        snapshot_id: summary.id,
        against: previous.id,
        changed_keys: diff.changed.map((c) => c.field_key).slice(0, 20),
      },
    });
  }

  return {
    watched: watches.length,
    snapshots_taken: snapshots,
    completed,
    hours_logged: hoursLogged,
  };
}

/** The status screen's read: newest first, real entries only (P1-47). */
export async function watchLog(profileId: string, limit = 50) {
  return db
    .select()
    .from(watchActivity)
    .where(eq(watchActivity.profile_id, profileId))
    .orderBy(desc(watchActivity.at))
    .limit(limit);
}

/** True when any of these kinds exist — used to avoid double "started". */
export async function hasActivity(profileId: string, kinds: string[]): Promise<boolean> {
  const [row] = await db
    .select({ id: watchActivity.id })
    .from(watchActivity)
    .where(and(eq(watchActivity.profile_id, profileId), inArray(watchActivity.kind, kinds)))
    .limit(1);
  return row !== undefined;
}
