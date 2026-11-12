// The peer pool — the v1 build spec §5.3 (P7-62): each business's measured
// month, read from its connectors and nothing else.
//
// "Only connector-measured values enter the cohort pool. Owner-stated
// numbers may be compared against a cohort but never contribute to one."
// So a member's values come only from metric_observations under a
// measuring connection; the owner's facts give only what places it — its
// business type (→ NACE), its country, and its headcount, which §5.3 names
// as the one stated input to revenue per employee. An imported bank
// statement's money in is not revenue and isn't read here (D52).
//
// One source per series: where two connections both measure revenue, the
// one with more days that month is read, never both added together.

import { and, eq, gte, inArray, isNull, lte, ne, sql } from "drizzle-orm";
import { db } from "../../db";
import { businessProfiles, connections, fieldRecords, metricObservations } from "../../db/schema";
import { countryCode } from "../core/country";
import { enumCode } from "../core/enum-value";
import { toEur } from "../core/fx";
import { perUnit, ratioBp } from "../core/money";
import { rateOn } from "../fx/ecb";
import type { Member, MemberValue, PeerMetric } from "./cohort";
import { MIN_DAYS_IN_MONTH, bandOf, naceOfType } from "./cohort";

const FACT_KEYS = ["identity.business_type", "legal.country", "identity.team_size"] as const;
const SERIES = [
  "revenue.daily",
  "orders.daily",
  "ad_spend.daily",
  "appointments_completed.daily",
  "appointments_no_show.daily",
  "appointments_cancelled_late.daily",
] as const;

/** "2026-10" → its first and last day. */
export function monthBounds(month: string): { first: string; last: string } {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error("a month is YYYY-MM");
  const [y, m] = month.split("-").map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  return { first: `${month}-01`, last };
}

/** The last complete calendar month before `now` (§5.1's rolling month). */
export function lastCompleteMonth(now: Date): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return d.toISOString().slice(0, 7);
}

interface SeriesSum {
  connection: string;
  money: number;
  count: number;
  currency: string | null;
  days: number;
}

/** The facts that place a business, from its current records. */
async function placingFacts(profileIds: readonly string[]) {
  const out = new Map<
    string,
    { type: string | null; country: string | null; team: number | null }
  >();
  if (profileIds.length === 0) return out;
  const rows = await db
    .select({
      profile_id: fieldRecords.profile_id,
      key: fieldRecords.field_key,
      value: fieldRecords.value,
    })
    .from(fieldRecords)
    .where(
      and(
        inArray(fieldRecords.profile_id, [...profileIds]),
        inArray(fieldRecords.field_key, [...FACT_KEYS]),
        isNull(fieldRecords.superseded_at),
      ),
    );
  for (const id of profileIds) out.set(id, { type: null, country: null, team: null });
  for (const r of rows) {
    const f = out.get(r.profile_id)!;
    if (r.key === "identity.business_type") f.type = enumCode(r.value);
    if (r.key === "legal.country" && typeof r.value === "string") f.country = countryCode(r.value);
    if (
      r.key === "identity.team_size" &&
      typeof r.value === "number" &&
      Number.isSafeInteger(r.value) &&
      r.value > 0
    )
      f.team = r.value;
  }
  return out;
}

/** The series with the most days that month (ties: the lower connection id). */
function best(list: readonly SeriesSum[] | undefined): SeriesSum | null {
  if (!list || list.length === 0) return null;
  return [...list].sort((a, b) => b.days - a.days || a.connection.localeCompare(b.connection))[0]!;
}

/**
 * Every business's measured month, opted-out businesses included — the
 * caller decides who contributes (lib/peers/benchmark.ts). A business
 * without a measured month has no values; one SYB can't place has nulls.
 */
export async function membersFor(month: string): Promise<Member[]> {
  const { first, last } = monthBounds(month);
  const profiles = await db
    .select({ id: businessProfiles.id, account_id: businessProfiles.account_id })
    .from(businessProfiles);
  const facts = await placingFacts(profiles.map((p) => p.id));

  const sums = await db
    .select({
      account_id: connections.account_id,
      connection: metricObservations.connection_id,
      metric: metricObservations.metric_key,
      currency: metricObservations.currency,
      money: sql<string>`coalesce(sum(${metricObservations.value_minor}), 0)::text`,
      count: sql<string>`coalesce(sum(${metricObservations.value_num}), 0)::text`,
      days: sql<number>`count(distinct ${metricObservations.period_date})::int`,
    })
    .from(metricObservations)
    .innerJoin(connections, eq(connections.id, metricObservations.connection_id))
    .where(
      and(
        // Measured only: a connector reading the business, never an execute
        // grant or a file import (§5.3).
        eq(connections.purpose, "measure"),
        ne(connections.status, "disconnected"),
        inArray(metricObservations.metric_key, [...SERIES]),
        gte(metricObservations.period_date, first),
        lte(metricObservations.period_date, last),
      ),
    )
    .groupBy(
      connections.account_id,
      metricObservations.connection_id,
      metricObservations.metric_key,
      metricObservations.currency,
    );
  const byAccount = new Map<string, Map<string, SeriesSum[]>>();
  for (const s of sums) {
    const series = byAccount.get(s.account_id) ?? new Map<string, SeriesSum[]>();
    const list = series.get(s.metric) ?? [];
    list.push({
      connection: s.connection,
      money: Number(s.money),
      count: Math.round(Number(s.count)), // not money: a count of orders or appointments
      currency: s.currency,
      days: s.days,
    });
    series.set(s.metric, list);
    byAccount.set(s.account_id, series);
  }

  const rates = new Map<string, Awaited<ReturnType<typeof rateOn>>>();
  const members: Member[] = [];
  for (const p of profiles) {
    const f = facts.get(p.id)!;
    const series = byAccount.get(p.account_id);
    const revenue = best(series?.get("revenue.daily"));
    const values: Partial<Record<PeerMetric, MemberValue>> = {};
    let revenueEur = 0;
    let band: string | null = null;
    if (revenue && revenue.days >= MIN_DAYS_IN_MONTH && revenue.currency && revenue.money > 0) {
      const currency = revenue.currency;
      if (currency === "EUR") revenueEur = revenue.money;
      else {
        if (!rates.has(currency)) rates.set(currency, await rateOn(currency, last));
        const rate = rates.get(currency);
        if (rate) revenueEur = toEur({ amount_minor: revenue.money, currency }, rate).amount_minor;
      }
      if (revenueEur > 0) band = bandOf(revenueEur * 12);

      const orders = series?.get("orders.daily")?.find((o) => o.connection === revenue.connection);
      if (orders && orders.days >= MIN_DAYS_IN_MONTH && orders.count > 0) {
        values.average_order_value = {
          value: perUnit(revenue.money, orders.count),
          numerator: revenue.money,
          denominator: orders.count,
          currency,
        };
      }
      if (f.team !== null) {
        values.revenue_per_employee = {
          value: perUnit(revenue.money, f.team),
          numerator: revenue.money,
          denominator: f.team,
          currency,
        };
      }
      const ads = best(series?.get("ad_spend.daily")?.filter((a) => a.currency === currency));
      if (ads && ads.days >= MIN_DAYS_IN_MONTH) {
        values.ad_spend_share = {
          value: ratioBp(ads.money, revenue.money),
          numerator: ads.money,
          denominator: revenue.money,
          currency,
        };
      }
    }
    const done = best(series?.get("appointments_completed.daily"));
    if (done && done.days >= MIN_DAYS_IN_MONTH) {
      const same = (k: string) =>
        series?.get(k)?.find((x) => x.connection === done.connection)?.count ?? 0;
      const missed = same("appointments_no_show.daily") + same("appointments_cancelled_late.daily");
      const booked = done.count + missed;
      if (booked > 0) {
        values.no_show_rate = {
          value: ratioBp(missed, booked),
          numerator: missed,
          denominator: booked,
          currency: null,
        };
      }
    }
    members.push({
      business: p.id,
      nace: naceOfType(f.type),
      country: f.country,
      band,
      revenue_eur_minor: revenueEur,
      values,
    });
  }
  return members;
}
