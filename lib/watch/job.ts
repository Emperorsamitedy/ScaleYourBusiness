// The weekly watch job — Session H (P1-46). For every profile under an
// active watch: freeze the profile, diff it against the previous
// snapshot, and write what ACTUALLY happened to the activity log. Every
// entry corresponds to real work performed — a watch that did nothing
// says "held steady", it does not invent motion.
//
// P2-30: the same beat reads the trading-hours findings and logs them
// when the signals move — which fire, on which days — so an unchanged
// finding is said once, not every week.
//
// P5-08: and the 13-week cash forecast's tight week, the same way: logged
// when it first appears or moves, and once more when it clears. A warning
// is a line to read, never a push to act; nothing is proposed or sent.
//
// Warnings sent at once (2026-11-20): the same look is taken every morning
// between two Mondays (runDailyCashWarnings, from lib/warnings/daily), so a
// tight week that appears on a Wednesday is on record that Wednesday. The
// morning look writes ONLY a warning that has just appeared; what moved or
// cleared still waits for Monday. Who is told, and how, is not decided here
// (lib/warnings/sweep reads the lines this file writes).

import { logSafeError } from "../core/log-safe";
import { and, desc, eq, gt, inArray } from "drizzle-orm";
import { db } from "../../db";
import { businessProfiles, modeDecisions, watchActivity } from "../../db/schema";
import { loadCashInputs } from "../cash/load";
import type { CashForecast } from "../cash/model";
import { forecastCash } from "../cash/model";
import type { TightWeek } from "../cash/warnings";
import { clearedSentence, tightWeek } from "../cash/warnings";
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
  /** P5-08: profiles whose cash warning appeared, moved or cleared, and was logged. */
  cash_logged: number;
}

export const CASH_WARNING_KIND = "cash_warning";

async function readCashForecast(profileId: string, now: Date): Promise<CashForecast> {
  const [profile] = await db
    .select({ account_id: businessProfiles.account_id })
    .from(businessProfiles)
    .where(eq(businessProfiles.id, profileId));
  if (!profile) throw new Error("no such business");
  return forecastCash(await loadCashInputs(profile.account_id, profileId, now));
}

/**
 * Pure: does the tight week now found cover days the standing warning's week
 * already covers, against the same line in the same currency? Then it is the
 * week that stands, counted from another day, not a move. `stands` is the
 * standing line's meta as this file wrote it.
 */
export function sameWeekRecounted(stands: unknown, tight: TightWeek, currency: string): boolean {
  const m = (stands ?? {}) as Record<string, unknown>;
  if (typeof m.week_start !== "string" || typeof m.week_end !== "string") return false;
  if (m.line_kind !== tight.line_kind || m.line !== tight.line || m.currency !== currency) {
    return false;
  }
  return m.week_start <= tight.end && tight.start <= m.week_end;
}

/**
 * P5-08: log the cash forecast's first tight week when it differs from the
 * last one logged, and say once when a logged warning no longer holds.
 * A forecast that refuses (too little history, no cash figure) logs
 * nothing: the /cash screen says why. Returns whether an entry was
 * written; a failure here never stops the watch.
 *
 * `appearing_only` is the morning look between two Mondays: it writes a
 * tight week only when no warning stands (none said yet, or the last one
 * cleared). The forecast's weeks start today, so its first tight week
 * "moves" a day every morning; logging that would be a line a day.
 *
 * For the same reason the week that stands may be counted from another
 * weekday than this beat's weeks are. The same stretch of days, held to the
 * same line, has not moved (sameWeekRecounted), and is not logged again.
 */
export async function logCashWarning(
  profileId: string,
  now: Date,
  read: (profileId: string, now: Date) => Promise<CashForecast> = readCashForecast,
  opts: { appearing_only?: boolean } = {},
): Promise<boolean> {
  let forecast: CashForecast;
  try {
    forecast = await read(profileId, now);
  } catch (error) {
    console.error(
      JSON.stringify({ event: "watch_cash_failed", profile_id: profileId, ...logSafeError(error) }),
    );
    return false;
  }
  if (forecast.status !== "ready") return false;
  const tight = tightWeek(forecast);
  const signature = tight?.signature ?? "";

  const [last] = await db
    .select({ meta: watchActivity.meta })
    .from(watchActivity)
    .where(and(eq(watchActivity.profile_id, profileId), eq(watchActivity.kind, CASH_WARNING_KIND)))
    .orderBy(desc(watchActivity.at))
    .limit(1);
  const previous = (last?.meta as { signature?: string } | null)?.signature ?? "";
  if (signature === previous) return false; // unchanged, or nothing to say and nothing said
  if (opts.appearing_only && previous !== "") return false; // one stands: Monday says what moved
  if (tight && previous !== "" && sameWeekRecounted(last?.meta, tight, forecast.currency)) {
    return false;
  }

  await db.insert(watchActivity).values({
    profile_id: profileId,
    kind: CASH_WARNING_KIND,
    detail: tight ? tight.sentence : clearedSentence(forecast),
    meta: tight
      ? {
          signature,
          week_start: tight.start,
          week_end: tight.end,
          currency: forecast.currency,
          balance: tight.balance,
          line: tight.line,
          line_kind: tight.line_kind,
          reasons: tight.reasons,
        }
      : { signature: "", cleared: true },
  });
  return true;
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
        ...logSafeError(error),
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

/**
 * The morning look at cash, between two Mondays: every business under an
 * unexpired watch, one failure never stopping the rest. Returns how many
 * warnings appeared.
 */
export async function runDailyCashWarnings(
  now = new Date(),
  opts: { profileIds?: readonly string[] } = {},
): Promise<{ looked: number; appeared: number }> {
  const watches = (await activeWatches()).filter(
    (w) =>
      Date.parse(w.review_at) > now.getTime() &&
      (!opts.profileIds || opts.profileIds.includes(w.profile_id)),
  );
  let appeared = 0;
  for (const watch of watches) {
    try {
      if (await logCashWarning(watch.profile_id, now, readCashForecast, { appearing_only: true })) {
        appeared++;
      }
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "daily_cash_failed",
          profile_id: watch.profile_id,
          ...logSafeError(error),
        }),
      );
    }
  }
  return { looked: watches.length, appeared };
}

export async function runWeeklyWatch(
  now = new Date(),
  // Tests scope the run to their own profiles so other watched businesses
  // in a shared database (a local demo, say) neither slow nor touch them.
  // The cron passes nothing and walks every active watch.
  opts: { profileIds?: readonly string[] } = {},
): Promise<WatchRunResult> {
  const all = await activeWatches();
  const watches = opts.profileIds
    ? all.filter((w) => opts.profileIds!.includes(w.profile_id))
    : all;
  let snapshots = 0;
  let completed = 0;
  let hoursLogged = 0;
  let cashLogged = 0;

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
    if (await logCashWarning(watch.profile_id, now)) cashLogged++;

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
            : "Weekly check: the profile held steady. Nothing changed since last week.",
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
    cash_logged: cashLogged,
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
