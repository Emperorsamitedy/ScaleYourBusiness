// Nightly anomaly detection on a connection's measured series — P2-22..25.
//
// Runs at the end of every sync (the daily cron, or "Sync now"). For each
// business-wide series the connection measures, revenue per currency,
// orders, sessions, ad spend, it asks the baseline whether the latest days
// are a run beyond the usual variation. The outcomes:
//
//   detected    a new run: an anomaly row, a watch log line with the
//               arithmetic, and, when it crosses an interruption rule, the
//               interruption the status screen has been promising
//   continuing  the open anomaly is still running: its last day advances,
//               nothing new is said (the log is not a nag)
//   cleared     the series is back within its baseline: the row is resolved,
//               never deleted, and the log says so
//   normal      nothing to report
//   insufficient fewer than 14 days of history: no verdict, honestly
//
// P2-25: every anomaly stores the baseline's inputs verbatim. A false
// positive can be replayed from the row alone, and the constants in
// baseline.ts tuned from evidence rather than taste.

import { and, eq, gte, isNull } from "drizzle-orm";
import { db } from "../../db";
import {
  anomalies,
  businessProfiles,
  connections,
  metricObservations,
  watchActivity,
} from "../../db/schema";
import { latestObservedDate } from "../connectors/derive";
import type { MetricKey } from "../connectors/provider";
import { MONEY_METRICS, isMetricKey } from "../connectors/provider";
import type { AnomalyRun, Series, WeekOverWeek } from "./baseline";
import {
  BASELINE_WINDOW_DAYS,
  MAD_K,
  RUN_DAYS,
  WEEKDAY_NAMES,
  computeBaseline,
  detectRun,
  shiftDay,
  weekOverWeek,
} from "./baseline";
import { INTERRUPT_RULES, interruptFor } from "./thresholds";

export interface AnomalyOutcome {
  metric_key: string;
  dimension_key: string;
  outcome: "detected" | "continuing" | "cleared" | "normal" | "insufficient";
  anomaly_id?: string;
  direction?: "drop" | "spike";
  severity?: "notice" | "interrupt";
}

const METRIC_NOUN: Readonly<Record<string, string>> = {
  "revenue.daily": "Revenue",
  "orders.daily": "Orders",
  "sessions.daily": "Website visits",
  "ad_spend.daily": "Ad spend",
  "ad_purchases.daily": "Ad purchases",
  "units.daily": "Units sold",
};

function formatValue(value: number, currency: string | null): string {
  if (currency !== null) {
    const major = (value / 100).toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    return `${major.replace(/,/g, " ")} ${currency}`;
  }
  return Math.round(value).toLocaleString("en-US").replace(/,/g, " ");
}

/** The arithmetic, in words, as the watch log and the status screen show it. */
export function describeRun(
  metric: string,
  currency: string | null,
  run: AnomalyRun,
  wow: WeekOverWeek,
  interrupt: { text: string; drop_threshold: number } | null,
): string {
  const last = run.days[run.days.length - 1];
  if (!last) return "";
  const b = last.baseline;
  const noun = `${METRIC_NOUN[metric] ?? metric}${currency ? ` (${currency})` : ""}`;
  const verb = run.direction === "drop" ? "fell" : "rose";
  const rel = run.direction === "drop" ? "below" : "above";
  const pct = Math.abs(Math.round(last.pct * 100));
  const weekday = WEEKDAY_NAMES[b.weekday] ?? "weekday";
  let text =
    `${noun} ${verb} ${pct}% ${rel} the expected level for ${run.days.length} days in a row: ` +
    `${formatValue(last.actual, currency)} on ${last.date} against an expected ${formatValue(b.expected, currency)} ` +
    `(${BASELINE_WINDOW_DAYS}-day average ${formatValue(b.overall_mean, currency)} × ${weekday} factor ${b.weekday_factor.toFixed(2)}; ` +
    `${Math.abs(last.deviation).toFixed(1)}× the usual variation, threshold ${MAD_K}×).`;
  if (interrupt !== null && wow.change !== null) {
    text +=
      ` Week over week it is down ${Math.abs(Math.round(wow.change * 100))}% ` +
      `(${formatValue(wow.last7, currency)} against ${formatValue(wow.prior7, currency)}), ` +
      `past the ${Math.round(interrupt.drop_threshold * 100)}% interruption threshold.`;
  }
  return text;
}

interface LoadedSeries {
  metric: MetricKey;
  dimension_key: string;
  currency: string | null;
  values: Map<string, number>;
  endDate: string;
}

/** Every business-wide series the connection measures, with enough history to judge the latest day. */
async function loadSeries(connectionId: string, latest: string): Promise<LoadedSeries[]> {
  const rows = await db
    .select({
      metric_key: metricObservations.metric_key,
      dimension_key: metricObservations.dimension_key,
      dimensions: metricObservations.dimensions,
      period_date: metricObservations.period_date,
      value_minor: metricObservations.value_minor,
      currency: metricObservations.currency,
      value_num: metricObservations.value_num,
    })
    .from(metricObservations)
    .where(
      and(
        eq(metricObservations.connection_id, connectionId),
        gte(
          metricObservations.period_date,
          shiftDay(latest, -(BASELINE_WINDOW_DAYS + RUN_DAYS + 14)),
        ),
      ),
    );

  const series = new Map<string, LoadedSeries>();
  for (const row of rows) {
    if (!isMetricKey(row.metric_key)) continue;
    if (!Object.keys(row.dimensions ?? {}).every((k) => k === "currency")) continue;
    const key = `${row.metric_key}|${row.dimension_key}`;
    const entry = series.get(key) ?? {
      metric: row.metric_key,
      dimension_key: row.dimension_key,
      currency: MONEY_METRICS.has(row.metric_key) ? row.currency : null,
      values: new Map<string, number>(),
      endDate: row.period_date,
    };
    const value = MONEY_METRICS.has(row.metric_key)
      ? (row.value_minor ?? 0)
      : Number(row.value_num ?? 0);
    entry.values.set(row.period_date, value);
    if (row.period_date > entry.endDate) entry.endDate = row.period_date;
    series.set(key, entry);
  }
  return [...series.values()];
}

function log(event: string, payload: Record<string, unknown>): void {
  console.log(JSON.stringify({ event, ...payload }));
}

/** Detect, record and report anomalies on one connection's series. */
export async function detectAnomalies(
  connectionId: string,
  now = new Date(),
): Promise<AnomalyOutcome[]> {
  const [conn] = await db.select().from(connections).where(eq(connections.id, connectionId));
  if (!conn) return [];
  const [profile] = await db
    .select({ id: businessProfiles.id })
    .from(businessProfiles)
    .where(eq(businessProfiles.account_id, conn.account_id));
  if (!profile) return [];
  const latest = await latestObservedDate(connectionId);
  if (latest === null) return [];

  const outcomes: AnomalyOutcome[] = [];
  for (const s of await loadSeries(connectionId, latest)) {
    const values: Series = s.values;
    const [open] = await db
      .select()
      .from(anomalies)
      .where(
        and(
          eq(anomalies.connection_id, connectionId),
          eq(anomalies.metric_key, s.metric),
          eq(anomalies.dimension_key, s.dimension_key),
          isNull(anomalies.resolved_at),
        ),
      );

    if (computeBaseline(values, s.endDate) === null) {
      outcomes.push({
        metric_key: s.metric,
        dimension_key: s.dimension_key,
        outcome: "insufficient",
      });
      continue;
    }

    const run = detectRun(values, s.endDate);
    const wow = weekOverWeek(values, s.endDate);

    if (run === null) {
      if (open) {
        await db
          .update(anomalies)
          .set({ resolved_at: now.toISOString() })
          .where(eq(anomalies.id, open.id));
        await db.insert(watchActivity).values({
          profile_id: profile.id,
          kind: "anomaly_cleared",
          detail: `${METRIC_NOUN[s.metric] ?? s.metric}${s.currency ? ` (${s.currency})` : ""} is back within its usual range as of ${s.endDate}.`,
          meta: { anomaly_id: open.id, metric_key: s.metric, direction: open.direction },
        });
        log("anomaly_cleared", {
          account_id: conn.account_id,
          connection_id: connectionId,
          anomaly_id: open.id,
          metric_key: s.metric,
        });
        outcomes.push({
          metric_key: s.metric,
          dimension_key: s.dimension_key,
          outcome: "cleared",
          anomaly_id: open.id,
          direction: open.direction,
          severity: open.severity,
        });
      } else {
        outcomes.push({ metric_key: s.metric, dimension_key: s.dimension_key, outcome: "normal" });
      }
      continue;
    }

    const last = run.days[run.days.length - 1];
    const first = run.days[0];
    if (!last || !first) continue;

    if (open && open.direction === run.direction) {
      await db
        .update(anomalies)
        .set({
          last_date: last.date,
          run_days: open.run_days + Math.max(0, daysBetween(open.last_date, last.date)),
          actual: last.actual.toFixed(4),
          expected: last.expected.toFixed(4),
          deviation: last.deviation.toFixed(3),
        })
        .where(eq(anomalies.id, open.id));
      outcomes.push({
        metric_key: s.metric,
        dimension_key: s.dimension_key,
        outcome: "continuing",
        anomaly_id: open.id,
        direction: open.direction,
        severity: open.severity,
      });
      continue;
    }
    if (open) {
      // The series swung the other way: the old anomaly is over, a new one starts.
      await db
        .update(anomalies)
        .set({ resolved_at: now.toISOString() })
        .where(eq(anomalies.id, open.id));
    }

    const rule = interruptFor(s.metric, run, wow);
    const severity = rule === null ? "notice" : "interrupt";
    const detail = describeRun(s.metric, s.currency, run, wow, rule);
    const [row] = await db
      .insert(anomalies)
      .values({
        profile_id: profile.id,
        connection_id: connectionId,
        metric_key: s.metric,
        dimension_key: s.dimension_key,
        direction: run.direction,
        severity,
        first_date: first.date,
        last_date: last.date,
        run_days: run.days.length,
        actual: last.actual.toFixed(4),
        expected: last.expected.toFixed(4),
        deviation: last.deviation.toFixed(3),
        detail,
        inputs: {
          constants: { window_days: BASELINE_WINDOW_DAYS, k: MAD_K, run_days: RUN_DAYS },
          baseline: last.baseline,
          days: run.days.map((d) => ({
            date: d.date,
            actual: d.actual,
            expected: d.expected,
            deviation: d.deviation,
            pct: d.pct,
          })),
          week_over_week: wow,
          rule: rule?.id ?? null,
        },
      })
      .returning({ id: anomalies.id });
    if (!row) continue;

    await db.insert(watchActivity).values({
      profile_id: profile.id,
      kind: severity === "interrupt" ? "watch_interrupted" : "anomaly_detected",
      detail,
      meta: {
        anomaly_id: row.id,
        metric_key: s.metric,
        direction: run.direction,
        severity,
        rule: rule?.id ?? null,
      },
    });
    log(severity === "interrupt" ? "watch_interrupted" : "anomaly_detected", {
      account_id: conn.account_id,
      connection_id: connectionId,
      anomaly_id: row.id,
      metric_key: s.metric,
      direction: run.direction,
      deviation: Number(last.deviation.toFixed(3)),
      rule: rule?.id ?? null,
    });
    outcomes.push({
      metric_key: s.metric,
      dimension_key: s.dimension_key,
      outcome: "detected",
      anomaly_id: row.id,
      direction: run.direction,
      severity,
    });
  }
  return outcomes;
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

export interface OpenInterruption {
  id: string;
  metric_key: string;
  direction: "drop" | "spike";
  detail: string;
  detected_at: string;
  last_date: string;
}

/** The open anomalies that crossed an interruption rule, for the status screen (P2-24). */
export async function openInterruptions(profileId: string): Promise<OpenInterruption[]> {
  const rows = await db
    .select()
    .from(anomalies)
    .where(
      and(
        eq(anomalies.profile_id, profileId),
        eq(anomalies.severity, "interrupt"),
        isNull(anomalies.resolved_at),
      ),
    );
  return rows
    .map((r) => ({
      id: r.id,
      metric_key: r.metric_key,
      direction: r.direction,
      detail: r.detail,
      detected_at: r.detected_at,
      last_date: r.last_date,
    }))
    .sort((a, b) => Date.parse(b.detected_at) - Date.parse(a.detected_at));
}

export { INTERRUPT_RULES };
