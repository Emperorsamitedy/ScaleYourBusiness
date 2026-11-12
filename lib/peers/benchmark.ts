// Serving a peer benchmark — the v1 build spec §5 (P7-60..64).
//
// The query layer: every aggregate over other businesses leaves through
// `cohortQuery` or `peerBenchmark`, and both go through `distribution`
// (./cohort), which is the floor. Nothing here takes a list of businesses
// from a caller, and nothing returns a member's own value.
//
// The pool is every business that hasn't opted out (§5.5), never the
// reader (D15). The reader's own value — measured if it can be, else what
// the owner said, labelled so — is compared against the cohort and never
// joins it (§5.3). Every answer carries its source and as-of date (§5.4);
// when no cohort reaches the floor the answer says so, and the official
// figures stay their own, labelled with their vintage, never blended.

import { and, eq, isNull } from "drizzle-orm";
import { db } from "../../db";
import { fieldRecords } from "../../db/schema";
import { isIsoCurrency, perUnit } from "../core/money";
import type { CohortSpec, Member, PeerMetric, Widening } from "./cohort";
import { MEASURED_METRICS, PEER_METRICS, cohortLadder, distribution, inCohort } from "./cohort";
import { optedOutProfiles } from "./consent";
import { lastCompleteMonth, membersFor, monthBounds } from "./pool";

export const PEER_SOURCE = "syb_peer_cohort";

/** The pool for a month: every placed business that hasn't opted out. Never exported. */
async function poolFor(month: string): Promise<{ all: Member[]; pool: Member[] }> {
  const [all, out] = await Promise.all([membersFor(month), optedOutProfiles()]);
  return { all, pool: all.filter((m) => !out.has(m.business)) };
}

/**
 * The query layer's one door for an arbitrary cohort: the floor applies to
 * whatever is asked, however narrow. The reader is never in their cohort.
 */
export async function cohortQuery(args: {
  spec: CohortSpec;
  metric: PeerMetric;
  month: string;
  readerProfileId: string;
  readerCurrency: string | null;
}) {
  const { pool } = await poolFor(args.month);
  const members = pool.filter((m) => m.business !== args.readerProfileId && inCohort(m, args.spec));
  return distribution(members, args.metric, args.readerCurrency);
}

export type Own = { value: number; basis: "measured" | "stated"; percentile: number };

export type PeerBenchmark =
  | {
      metric: PeerMetric;
      status: "served";
      unit: (typeof PEER_METRICS)[PeerMetric]["unit"];
      currency: string | null;
      p25: number;
      p50: number;
      p75: number;
      own: Own | null;
      cohort: CohortSpec & { businesses: number; month: string; widened: Widening[] };
      source: typeof PEER_SOURCE;
      as_of: string;
    }
  | {
      metric: PeerMetric;
      status: "not_enough";
      month: string;
      source: typeof PEER_SOURCE;
      as_of: string;
    }
  | { metric: PeerMetric; status: "not_measured" }
  | { metric: PeerMetric; status: "unplaced"; missing: ("business_type" | "country")[] };

/** What the owner said, for their own comparison only — never a member value. */
async function statedOwn(
  profileId: string,
  metric: PeerMetric,
  currency: string | null,
): Promise<number | null> {
  if (metric !== "average_order_value" && metric !== "revenue_per_employee") return null;
  const rows = await db
    .select({ key: fieldRecords.field_key, value: fieldRecords.value })
    .from(fieldRecords)
    .where(and(eq(fieldRecords.profile_id, profileId), isNull(fieldRecords.superseded_at)));
  const get = (k: string) => rows.find((r) => r.key === k)?.value;
  const revenue = get("revenue.monthly_revenue") as
    { amount_minor?: unknown; currency?: unknown } | undefined;
  if (
    !revenue ||
    !Number.isSafeInteger(revenue.amount_minor) ||
    typeof revenue.currency !== "string"
  )
    return null;
  if (!isIsoCurrency(revenue.currency) || (currency !== null && revenue.currency !== currency))
    return null;
  const by =
    metric === "average_order_value"
      ? get("revenue.order_count_monthly")
      : get("identity.team_size");
  if (typeof by !== "number" || !Number.isSafeInteger(by) || by <= 0) return null;
  return perUnit(revenue.amount_minor as number, by);
}

/** The reader's currency: their measured revenue's, else the one they stated. */
async function readerCurrencyOf(
  profileId: string,
  measured: Member | undefined,
): Promise<string | null> {
  const v = measured?.values.average_order_value ?? measured?.values.revenue_per_employee;
  if (v?.currency) return v.currency;
  const [row] = await db
    .select({ value: fieldRecords.value })
    .from(fieldRecords)
    .where(
      and(
        eq(fieldRecords.profile_id, profileId),
        eq(fieldRecords.field_key, "revenue.monthly_revenue"),
        isNull(fieldRecords.superseded_at),
      ),
    );
  const c = (row?.value as { currency?: unknown } | undefined)?.currency;
  return typeof c === "string" && isIsoCurrency(c) ? c : null;
}

/**
 * The reader's band, from their measured month. A reader with no measured
 * month is compared across every band (D58): a stated revenue doesn't
 * place anyone in a band.
 */
function readerBand(measured: Member | undefined): string {
  return measured?.band ?? "any";
}

/**
 * §5's benchmarks for one business: each measured metric through the
 * widening ladder, the first rung that clears the floor served with the
 * widenings it took. Metrics SYB doesn't measure yet say so.
 */
export async function peerBenchmarks(
  profileId: string,
  now = new Date(),
): Promise<PeerBenchmark[]> {
  const month = lastCompleteMonth(now);
  const asOf = monthBounds(month).last;
  const { all, pool } = await poolFor(month);
  const reader = all.find((m) => m.business === profileId);
  const out: PeerBenchmark[] = [];
  const missing: ("business_type" | "country")[] = [];
  if (!reader?.nace) missing.push("business_type");
  if (!reader?.country) missing.push("country");

  const currency = await readerCurrencyOf(profileId, reader);
  const band = readerBand(reader);
  const others = pool.filter((m) => m.business !== profileId);

  for (const metric of Object.keys(PEER_METRICS) as PeerMetric[]) {
    if (!MEASURED_METRICS.includes(metric)) {
      out.push({ metric, status: "not_measured" });
      continue;
    }
    if (missing.length > 0 || !reader?.nace || !reader.country) {
      out.push({ metric, status: "unplaced", missing });
      continue;
    }
    const measuredOwn = reader.values[metric]?.value ?? null;
    const stated = measuredOwn === null ? await statedOwn(profileId, metric, currency) : null;
    const own = measuredOwn ?? stated;
    let served: PeerBenchmark | null = null;
    for (const rung of cohortLadder({ nace: reader.nace, country: reader.country, band })) {
      const d = distribution(
        others.filter((m) => inCohort(m, rung.spec)),
        metric,
        currency,
        own,
      );
      if (!d.shown) continue;
      served = {
        metric,
        status: "served",
        unit: PEER_METRICS[metric].unit,
        currency: d.currency,
        p25: d.p25,
        p50: d.p50,
        p75: d.p75,
        own:
          own === null || d.own_percentile === null
            ? null
            : {
                value: own,
                basis: measuredOwn !== null ? "measured" : "stated",
                percentile: d.own_percentile,
              },
        cohort: { ...rung.spec, businesses: d.businesses, month, widened: rung.widened },
        source: PEER_SOURCE,
        as_of: asOf,
      };
      break;
    }
    out.push(served ?? { metric, status: "not_enough", month, source: PEER_SOURCE, as_of: asOf });
  }
  return out;
}

export type AnonymousComparison =
  | {
      status: "served";
      metric: PeerMetric;
      currency: string | null;
      p25: number;
      p50: number;
      p75: number;
      /** The visitor's own estimate's percentile — always "stated" (§8.2: no connector). */
      own_percentile: number | null;
      cohort: CohortSpec & { businesses: number; month: string; widened: Widening[] };
      source: typeof PEER_SOURCE;
      as_of: string;
    }
  | {
      status: "not_enough";
      metric: PeerMetric;
      month: string;
      source: typeof PEER_SOURCE;
      as_of: string;
    };

/**
 * §8.2's one peer comparison for a visitor with no account (the free entry):
 * the same pool, the same ladder, the same floor. The visitor is in no pool,
 * so nobody is left out of it; their stated figure is compared, never added.
 */
export async function anonymousComparison(args: {
  nace: string;
  country: string;
  band: string;
  metric: PeerMetric;
  currency: string | null;
  own: number | null;
  now?: Date;
}): Promise<AnonymousComparison> {
  const month = lastCompleteMonth(args.now ?? new Date());
  const asOf = monthBounds(month).last;
  const { pool } = await poolFor(month);
  for (const rung of cohortLadder({ nace: args.nace, country: args.country, band: args.band })) {
    const d = distribution(
      pool.filter((m) => inCohort(m, rung.spec)),
      args.metric,
      args.currency,
      args.own,
    );
    if (!d.shown) continue;
    return {
      status: "served",
      metric: args.metric,
      currency: d.currency,
      p25: d.p25,
      p50: d.p50,
      p75: d.p75,
      own_percentile: d.own_percentile,
      cohort: { ...rung.spec, businesses: d.businesses, month, widened: rung.widened },
      source: PEER_SOURCE,
      as_of: asOf,
    };
  }
  return { status: "not_enough", metric: args.metric, month, source: PEER_SOURCE, as_of: asOf };
}
