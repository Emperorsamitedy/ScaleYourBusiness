// The weekly watch job — Session H (P1-46). For every profile under an
// active watch: freeze the profile, diff it against the previous
// snapshot, and write what ACTUALLY happened to the activity log. Every
// entry corresponds to real work performed — a watch that did nothing
// says "held steady", it does not invent motion.

import { and, desc, eq, gt, inArray } from "drizzle-orm";
import { db } from "../../db";
import { modeDecisions, watchActivity } from "../../db/schema";
import { diffSnapshots, ensureSnapshot, listSnapshots } from "../profile/snapshot";

export interface WatchRunResult {
  watched: number;
  snapshots_taken: number;
  completed: number;
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

  return { watched: watches.length, snapshots_taken: snapshots, completed };
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
