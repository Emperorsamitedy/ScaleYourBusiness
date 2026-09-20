// Watching integration — P2-13.
//
// A sync that put new days on record writes one honest line to the
// profile's activity log ("Read 34 days of Stripe payments."), which makes
// the watch screen's ux-spec §6 example literally true. The watch job's
// rules apply unchanged:
//
//   · every entry is real work performed;
//   · a run that read nothing new, and changed no figure, writes nothing;
//   · telemetry never breaks the thing it describes.
//
// "New days" means days now on record that were not before this run: the
// cursor's advance, counted from the observations themselves. A tail
// re-read that only confirmed what was already stored is not news.

import { and, eq, gt, lte, sql } from "drizzle-orm";
import { db } from "../../db";
import { businessProfiles, metricObservations, watchActivity } from "../../db/schema";
import type { DeriveOutcome } from "./derive";
import { getProvider } from "./registry";
import { isProviderId } from "./scopes";

const FIELD_WORDS: Readonly<Record<string, string>> = {
  "revenue.monthly_revenue": "monthly revenue",
  "revenue.order_count_monthly": "order count",
  "marketing.monthly_ad_spend": "ad spend",
  "marketing.cost_per_purchase": "cost per purchase",
  "presence.monthly_sessions": "website visits",
};

/** What a derived fact is called in the log. */
function fieldWords(fieldKey: string): string {
  if (/^offers\.[^.]+\.volume_period$/.test(fieldKey)) return "units sold";
  if (/^channels\.[^.]+\.monthly_sessions$/.test(fieldKey)) return "visits per channel";
  return FIELD_WORDS[fieldKey] ?? fieldKey;
}

/** What a provider's days are called in the log. */
const DATA_NOUN: Readonly<Record<string, string>> = {
  stripe: "payments",
  shopify: "orders",
  woocommerce: "orders",
  ga4: "traffic",
  meta_ads: "ad spend",
};

function listWords(words: readonly string[]): string {
  if (words.length <= 1) return words[0] ?? "";
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * The log line for one sync, or null when there is nothing honest to say.
 * Only facts actually written count as "now measured".
 */
export function activityDetail(
  label: string,
  providerId: string,
  newDays: number,
  derived: readonly DeriveOutcome[],
): string | null {
  const measured = [
    ...new Set(derived.filter((d) => d.outcome === "written").map((d) => fieldWords(d.field_key))),
  ];

  if (newDays > 0) {
    const read = `Read ${newDays} ${newDays === 1 ? "day" : "days"} of ${label} ${DATA_NOUN[providerId] ?? "data"}.`;
    if (measured.length === 0) return read;
    return `${read} ${capitalise(listWords(measured))} ${measured.length === 1 ? "is" : "are"} now measured.`;
  }
  // Nothing new on record, but a re-read corrected a figure: real work too.
  return measured.length > 0
    ? `${capitalise(listWords(measured))} re-measured from ${label}.`
    : null;
}

/** Distinct days on record after `fromCursor` up to and including `toCursor`. */
export async function countNewDays(
  connectionId: string,
  fromCursor: string | null,
  toCursor: string | null,
): Promise<number> {
  if (toCursor === null) return 0;
  const [row] = await db
    .select({ days: sql<number>`count(distinct ${metricObservations.period_date})::int` })
    .from(metricObservations)
    .where(
      and(
        eq(metricObservations.connection_id, connectionId),
        fromCursor === null ? undefined : gt(metricObservations.period_date, fromCursor),
        lte(metricObservations.period_date, toCursor),
      ),
    );
  return Number(row?.days ?? 0);
}

export interface SyncActivityInput {
  connectionId: string;
  accountId: string;
  provider: string;
  /** The cursor before the run. */
  fromCursor: string | null;
  /** The cursor after the run. */
  toCursor: string | null;
  derived: readonly DeriveOutcome[];
}

/** Write the run's log line, if it has one. Never throws: a lost log line must not fail a sync. */
export async function recordSyncActivity(input: SyncActivityInput): Promise<void> {
  try {
    const [profile] = await db
      .select({ id: businessProfiles.id })
      .from(businessProfiles)
      .where(eq(businessProfiles.account_id, input.accountId));
    if (!profile) return;

    const days = await countNewDays(input.connectionId, input.fromCursor, input.toCursor);
    const label = isProviderId(input.provider) ? getProvider(input.provider).label : input.provider;
    const detail = activityDetail(label, input.provider, days, input.derived);
    if (detail === null) return;

    await db.insert(watchActivity).values({
      profile_id: profile.id,
      kind: "connector_sync",
      detail,
      meta: {
        connection_id: input.connectionId,
        provider: input.provider,
        new_days: days,
        from_cursor: input.fromCursor,
        to_cursor: input.toCursor,
      },
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "connector_activity_persist_failed",
        account_id: input.accountId,
        message: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}
