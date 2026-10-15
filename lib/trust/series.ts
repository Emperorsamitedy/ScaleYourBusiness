// Measured daily series for one profile — shared by the readback (P3-25)
// and goal progress (P3-44). One read, one rule: business-wide rows only
// (a row sliced by offer or channel would double-count — the anomaly
// layer's own rule), summed per day across every connection the account
// holds. Money sums value_minor with its currency (rule 1); counts sum
// value_num.

import { and, eq, gte, inArray, lte } from "drizzle-orm";
import { db } from "../../db";
import { businessProfiles, connections, metricObservations } from "../../db/schema";
import { MONEY_METRICS, type MetricKey } from "../connectors/provider";

export interface Series {
  /** period_date → the day's business-wide total (minor units for money). */
  values: Map<string, number>;
  /** The first currency seen; null for counts. */
  currency: string | null;
  /** Every currency seen — more than one means the sum is not one number. */
  currencies: Set<string>;
  /** Providers that contributed, for provenance ("connector:stripe:…"). */
  providers: Set<string>;
}

export function shiftDay(day: string, by: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + by);
  return d.toISOString().slice(0, 10);
}

/** Null when the profile has no connection at all. */
export async function dailySeries(
  profileId: string,
  metric: MetricKey,
  from: string,
  to: string,
): Promise<Series | null> {
  const [profile] = await db
    .select({ account_id: businessProfiles.account_id })
    .from(businessProfiles)
    .where(eq(businessProfiles.id, profileId));
  if (!profile) return null;
  const conns = await db
    .select({ id: connections.id })
    .from(connections)
    .where(eq(connections.account_id, profile.account_id));
  if (conns.length === 0) return null;

  const rows = await db
    .select({
      period_date: metricObservations.period_date,
      provider: metricObservations.provider,
      value_minor: metricObservations.value_minor,
      value_num: metricObservations.value_num,
      currency: metricObservations.currency,
      dimensions: metricObservations.dimensions,
    })
    .from(metricObservations)
    .where(
      and(
        inArray(
          metricObservations.connection_id,
          conns.map((c) => c.id),
        ),
        eq(metricObservations.metric_key, metric),
        gte(metricObservations.period_date, from),
        lte(metricObservations.period_date, to),
      ),
    );

  const isMoney = MONEY_METRICS.has(metric);
  const values = new Map<string, number>();
  const currencies = new Set<string>();
  const providers = new Set<string>();
  let currency: string | null = null;
  for (const row of rows) {
    // Business-wide rows only — the anomaly layer's own rule.
    if (!Object.keys(row.dimensions ?? {}).every((k) => k === "currency")) continue;
    const value = isMoney ? (row.value_minor ?? 0) : Number(row.value_num ?? 0);
    values.set(row.period_date, (values.get(row.period_date) ?? 0) + value);
    providers.add(row.provider);
    if (row.currency) {
      currencies.add(row.currency);
      currency = currency ?? row.currency;
    }
  }
  return { values, currency, currencies, providers };
}

export interface WindowStat {
  from: string;
  to: string;
  days_measured: number;
  /** Mean per measured day; minor units for money. */
  mean_minor: number;
}

export function windowStat(series: Series, from: string, to: string): WindowStat {
  let sum = 0;
  let days = 0;
  for (let day = from; day <= to; day = shiftDay(day, 1)) {
    const value = series.values.get(day);
    if (value !== undefined) {
      sum += value;
      days += 1;
    }
  }
  return { from, to, days_measured: days, mean_minor: days > 0 ? Math.round(sum / days) : 0 };
}
