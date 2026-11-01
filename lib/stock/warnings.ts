// Stock-out warnings into the watch log — Phase 5 Session A (P5-02).
//
// A warning is an observation, not a proposal: it lands in watch_activity
// as kind "stock_warning", one row per item whose cover falls below its
// delivery time, in the sentence the owner reads ("Speckled Everyday Mug
// runs out in about 4–6 days; Midland Clay Supplies takes 10 days."). The
// weekly summary reads the week's watch log, so the same row is the email's
// line under "What I noticed" (NOTED_KINDS). Rows are real: each carries the
// figures it was worked out from (rule 6) in its meta.
//
// Said once a week per item and level: re-running the beat, or running it
// by hand mid-week, writes nothing new unless an item's warning changed.
// Logged for every business in care, watched or not: watching forbids
// proposing (rule 15), not noticing. Nothing here proposes, orders or
// contacts anyone (rule 27), and nothing calls a model.

import { and, eq, gt } from "drizzle-orm";
import { db } from "../../db";
import { businessProfiles, modeDecisions, watchActivity } from "../../db/schema";
import { logSafeError } from "../core/log-safe";
import { stockClaims } from "../forecasts/claims";
import { recordForecastsQuietly } from "../forecasts/record";
import { isoWeek } from "../summary/week";
import { STOCK_WARNING_KIND } from "../watch/watch-view";
import type { CoverRow, CoverView } from "./cover-load";
import { loadCover } from "./cover-load";
import { stockApplies } from "./load";

export { STOCK_WARNING_KIND };

const DAY_MS = 86_400_000;

/** The once-a-week key: item, level and ISO week. */
export function warningSignature(row: Pick<CoverRow, "key" | "cover">, now: Date): string {
  return `${row.key}|${row.cover.warning?.level ?? "none"}|${isoWeek(now)}`;
}

/** What a warning row carries beside its sentence: the figures it rests on. */
export function warningMeta(row: CoverRow, now: Date) {
  const c = row.cover;
  return {
    signature: warningSignature(row, now),
    week: isoWeek(now),
    key: row.key,
    name: row.name,
    source: row.source,
    level: c.warning?.level ?? null,
    flag: c.warning?.flag ?? null,
    on_hand: row.item.on_hand,
    as_of: row.item.as_of,
    cover_days: c.cover
      ? {
          low: Math.round(c.cover.low * 10) / 10,
          high: c.cover.high === null ? null : Math.round(c.cover.high * 10) / 10,
        }
      : null,
    runs_out: c.runs_out,
    lead_days: c.lead.days,
    lead_basis: c.lead.basis,
    lead_source_field: c.lead.source_field,
    boosted: c.boosted,
    reorder_quantity: c.reorder?.quantity ?? null,
    sources: c.sources,
    assumed: c.assumed,
  };
}

/** Log this week's stock-out warnings for one business. Returns how many rows were written. */
export async function logStockWarnings(
  profileId: string,
  now: Date = new Date(),
  view?: CoverView,
): Promise<number> {
  const [profile] = await db
    .select({ account_id: businessProfiles.account_id })
    .from(businessProfiles)
    .where(eq(businessProfiles.id, profileId));
  if (!profile) return 0;
  if (!(await stockApplies(profileId))) return 0;
  const cover = view ?? (await loadCover(profile.account_id, profileId, now));
  if (cover.warnings.length === 0) return 0;
  // Idea 54: each warning's "runs out in about 4–6 days" goes on SYB's own
  // track record as it is said, once per item a week, to be graded later;
  // and (I-54c) not again while the item's earlier one still waits.
  await recordForecastsQuietly(
    stockClaims({ account_id: profile.account_id, profile_id: profileId }, cover, now),
    { account_id: profile.account_id, event: "forecasts_recorded_stock" },
  );

  const recent = await db
    .select({ meta: watchActivity.meta })
    .from(watchActivity)
    .where(
      and(
        eq(watchActivity.profile_id, profileId),
        eq(watchActivity.kind, STOCK_WARNING_KIND),
        gt(watchActivity.at, new Date(now.getTime() - 8 * DAY_MS).toISOString()),
      ),
    );
  const said = new Set(
    recent
      .map((r) => (r.meta as { signature?: unknown } | null)?.signature)
      .filter((s): s is string => typeof s === "string"),
  );

  let written = 0;
  for (const row of cover.warnings) {
    const meta = warningMeta(row, now);
    if (said.has(meta.signature)) continue;
    await db.insert(watchActivity).values({
      profile_id: profileId,
      at: now.toISOString(),
      kind: STOCK_WARNING_KIND,
      detail: row.cover.warning!.sentence,
      meta,
    });
    said.add(meta.signature);
    written++;
  }
  console.log(
    JSON.stringify({
      event: "stock_warnings",
      account_id: profile.account_id,
      profile_id: profileId,
      warnings: cover.warnings.length,
      written,
    }),
  );
  return written;
}

/** The weekly sweep: every business in care, one failure never stopping the rest. */
export async function runStockWarnings(
  now: Date = new Date(),
  opts: { profileIds?: readonly string[] } = {},
): Promise<{ logged: number; failed: number }> {
  const inCare = await db
    .selectDistinct({ profile_id: modeDecisions.profile_id })
    .from(modeDecisions);
  const ids = inCare
    .map((r) => r.profile_id)
    .filter((id) => !opts.profileIds || opts.profileIds.includes(id));
  let logged = 0;
  let failed = 0;
  for (const id of ids) {
    try {
      logged += await logStockWarnings(id, now);
    } catch (error) {
      failed++;
      console.error(
        JSON.stringify({ event: "stock_warnings_failed", profile_id: id, ...logSafeError(error) }),
      );
    }
  }
  return { logged, failed };
}
