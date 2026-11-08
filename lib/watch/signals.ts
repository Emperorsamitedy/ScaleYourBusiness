// What the watch is reading — the loader behind the Watching screen's
// "What I'm watching" table (the owner's Watching design, 2026-10-17).
// Read-only: every business-wide daily series each measure connection
// holds, the anomaly rows still open on them, and how many executions
// have run since the watch began. The verdicts are ./watch-view's.

import { and, count, eq, gte, inArray, isNull, or } from "drizzle-orm";
import { db } from "../../db";
import {
  anomalies,
  businessProfiles,
  connections,
  executions,
  metricObservations,
} from "../../db/schema";
import { BASELINE_WINDOW_DAYS, shiftDay } from "../anomaly/baseline";
import { MONEY_METRICS } from "../connectors/provider";
import { NON_CONNECTOR_SOURCE_LABELS } from "../bookings/source";
import { EXECUTE_READ_PROVIDERS, executeReadSource } from "../connectors/execute-reads";
import { getProvider } from "../connectors/registry";
import { isProviderId } from "../connectors/scopes";
import type { OpenAnomaly, WatchSignal, WatchedMetric } from "./watch-view";
import { SIGNAL_NOUN, WATCHED_METRICS, summariseSeries } from "./watch-view";

export interface WatchReading {
  signals: WatchSignal[];
  /** Measure connections being read now (status "connected") — what the daily sync walks. */
  connections: number;
  /** Executions started since day 1 of the watch. */
  executions_since_start: number;
}

function providerLabel(provider: string): string {
  return isProviderId(provider)
    ? getProvider(provider).label
    : (executeReadSource(provider)?.label ?? NON_CONNECTOR_SOURCE_LABELS[provider] ?? provider);
}

export async function loadWatchReading(
  profileId: string,
  watchStart: string,
): Promise<WatchReading> {
  const [profile] = await db
    .select({ account_id: businessProfiles.account_id })
    .from(businessProfiles)
    .where(eq(businessProfiles.id, profileId));
  const [ran] = await db
    .select({ n: count() })
    .from(executions)
    .where(
      and(
        eq(executions.profile_id, profileId),
        gte(executions.started_at, `${watchStart}T00:00:00Z`),
      ),
    );
  const executionsSince = Number(ran?.n ?? 0);
  if (!profile) return { signals: [], connections: 0, executions_since_start: executionsSince };

  const conns = await db
    .select({ id: connections.id, provider: connections.provider, status: connections.status })
    .from(connections)
    .where(
      and(
        eq(connections.account_id, profile.account_id),
        or(
          eq(connections.purpose, "measure"),
          // P2-20: an execute connection whose read is measurement (Google Ads).
          and(
            eq(connections.purpose, "execute"),
            inArray(connections.provider, [...EXECUTE_READ_PROVIDERS]),
          ),
        ),
      ),
    );
  // A disconnected or paused connection keeps its history, so its series still show.
  if (conns.length === 0) {
    return { signals: [], connections: 0, executions_since_start: executionsSince };
  }

  // Enough history before day 1 for the baseline to judge the latest day.
  const from = shiftDay(watchStart, -(BASELINE_WINDOW_DAYS + 14));
  const rows = await db
    .select({
      connection_id: metricObservations.connection_id,
      metric_key: metricObservations.metric_key,
      dimension_key: metricObservations.dimension_key,
      dimensions: metricObservations.dimensions,
      period_date: metricObservations.period_date,
      value_minor: metricObservations.value_minor,
      value_num: metricObservations.value_num,
      currency: metricObservations.currency,
    })
    .from(metricObservations)
    .where(
      and(
        inArray(
          metricObservations.connection_id,
          conns.map((c) => c.id),
        ),
        inArray(metricObservations.metric_key, [...WATCHED_METRICS]),
        gte(metricObservations.period_date, from),
      ),
    );

  const open = await db
    .select({
      connection_id: anomalies.connection_id,
      metric_key: anomalies.metric_key,
      dimension_key: anomalies.dimension_key,
      severity: anomalies.severity,
      direction: anomalies.direction,
      first_date: anomalies.first_date,
    })
    .from(anomalies)
    .where(and(eq(anomalies.profile_id, profileId), isNull(anomalies.resolved_at)));
  const openBy = new Map<string, OpenAnomaly>(
    open.map((a) => [
      `${a.connection_id}|${a.metric_key}|${a.dimension_key}`,
      { severity: a.severity, direction: a.direction, first_date: a.first_date },
    ]),
  );

  const series = new Map<
    string,
    {
      metric: WatchedMetric;
      currency: string | null;
      provider: string;
      values: Map<string, number>;
    }
  >();
  const providerOf = new Map(conns.map((c) => [c.id, c.provider]));
  for (const r of rows) {
    // Business-wide only — a row sliced by offer or channel would double-count (detect.ts's rule).
    if (!Object.keys(r.dimensions ?? {}).every((k) => k === "currency")) continue;
    const metric = r.metric_key as WatchedMetric;
    const money = MONEY_METRICS.has(metric);
    const key = `${r.connection_id}|${metric}|${r.dimension_key}`;
    const entry = series.get(key) ?? {
      metric,
      currency: money ? r.currency : null,
      provider: providerOf.get(r.connection_id) ?? "",
      values: new Map<string, number>(),
    };
    entry.values.set(r.period_date, money ? (r.value_minor ?? 0) : Number(r.value_num ?? 0));
    series.set(key, entry);
  }

  const signals: WatchSignal[] = [...series.entries()].map(([key, s]) => ({
    key,
    metric_key: s.metric,
    noun: SIGNAL_NOUN[s.metric],
    currency: s.currency,
    read_from: providerLabel(s.provider),
    ...summariseSeries({ values: s.values, watchStart, open: openBy.get(key) ?? null }),
  }));
  signals.sort(
    (a, b) =>
      WATCHED_METRICS.indexOf(a.metric_key) - WATCHED_METRICS.indexOf(b.metric_key) ||
      a.read_from.localeCompare(b.read_from),
  );
  return {
    signals,
    connections: conns.filter((c) => c.status === "connected").length,
    executions_since_start: executionsSince,
  };
}
