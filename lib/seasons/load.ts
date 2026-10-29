// Reading the season forecast's series — idea 46. Read-only: measured
// observations and the profile's own answers; nothing is written, no model
// is called, nothing leaves the database.
//
// Which series, as DATA (rule 4): the market chart's archetype row
// (lib/charts/profiles) names the money series a kind of business is read
// by, in order, then its volume series; the first that holds a year is
// used, else the first with anything at all (to say how much there is).
// The anomaly layer's series rules hold: business-wide rows only (a row
// sliced by product or campaign would double-count), money keeps its
// currency, and a series is ONE connection's — a shop and a payment account
// can both report the same sale, so two sources are never added together.

import { and, eq, gte, inArray, lte, or } from "drizzle-orm";
import { db } from "../../db";
import { connections, metricObservations } from "../../db/schema";
import { shiftDay } from "../anomaly/baseline";
import { SELLS_KEY, TYPE_KEY, sourceLabel } from "../charts/load";
import { CHART_ARCHETYPES, archetypeFor } from "../charts/profiles";
import { MONEY_METRICS, type MetricKey } from "../connectors/provider";
import { readCurrentField } from "../profile/field-store";
import type { SeasonResult, SeriesInfo } from "./forecast";
import { SEASONS, seasonForecast } from "./forecast";

export interface SeasonsView {
  result: SeasonResult;
  /** What to connect when nothing is measured, in the owner's words (the archetype's). */
  connect: string;
  /** Currencies of the same series left out, when the business is paid in more than one. */
  other_currencies: string[];
  /** Which connection and metric the series is (idea 54 grades a week against the same one). */
  series_ref?: { connection_id: string; metric: MetricKey } | null;
}

interface Candidate {
  metric: MetricKey;
  noun: string;
}

interface Group {
  connection: { id: string; provider: string };
  metric: MetricKey;
  currency: string | null;
  values: Map<string, number>;
}

export async function loadSeasons(
  accountId: string,
  profileId: string,
  now: Date = new Date(),
): Promise<SeasonsView> {
  const today = now.toISOString().slice(0, 10);
  const yesterday = shiftDay(today, -1);
  // Enough for the widest range: SEASONS.max_years of weeks, plus a week.
  const from = shiftDay(today, -(364 * SEASONS.max_years + 14));

  const type = await readCurrentField<unknown>(profileId, TYPE_KEY);
  const sells = await readCurrentField<unknown>(profileId, SELLS_KEY);
  const row =
    CHART_ARCHETYPES[
      archetypeFor(
        type?.status === "answered" ? type.value : null,
        sells?.status === "answered" ? sells.value : null,
      )
    ];
  const candidates: Candidate[] = [
    ...row.price.map((p) => ({ metric: p.metric, noun: p.noun })),
    ...row.volume.map((v) => ({ metric: v.metric, noun: v.word })),
  ];

  const conns = await db
    .select({ id: connections.id, provider: connections.provider })
    .from(connections)
    .where(
      and(
        eq(connections.account_id, accountId),
        or(eq(connections.purpose, "measure"), eq(connections.purpose, "import")),
      ),
    );
  const empty: SeasonsView = {
    result: { status: "no_data" },
    connect: row.connect,
    other_currencies: [],
  };
  if (conns.length === 0) return empty;
  const byId = new Map(conns.map((c) => [c.id, c]));

  const rows = await db
    .select({
      connection_id: metricObservations.connection_id,
      metric_key: metricObservations.metric_key,
      dimensions: metricObservations.dimensions,
      period_date: metricObservations.period_date,
      value_minor: metricObservations.value_minor,
      value_num: metricObservations.value_num,
      currency: metricObservations.currency,
    })
    .from(metricObservations)
    .where(
      and(
        inArray(metricObservations.connection_id, [...byId.keys()]),
        inArray(metricObservations.metric_key, [...new Set(candidates.map((c) => c.metric))]),
        gte(metricObservations.period_date, from),
        lte(metricObservations.period_date, yesterday),
      ),
    );

  const groups = new Map<string, Group>();
  for (const r of rows) {
    if (!Object.keys(r.dimensions ?? {}).every((k) => k === "currency")) continue;
    const connection = byId.get(r.connection_id);
    if (!connection) continue;
    const metric = r.metric_key as MetricKey;
    const isMoney = MONEY_METRICS.has(metric);
    if (isMoney && (r.value_minor === null || !r.currency)) continue;
    const key = `${r.connection_id}|${metric}|${isMoney ? r.currency : ""}`;
    const g = groups.get(key) ?? {
      connection,
      metric,
      currency: isMoney ? r.currency : null,
      values: new Map<string, number>(),
    };
    g.values.set(r.period_date, isMoney ? Number(r.value_minor) : Number(r.value_num ?? 0));
    groups.set(key, g);
  }

  const lastDay = (g: Group) => [...g.values.keys()].sort().at(-1) ?? "";
  const pick = (metric: MetricKey): Group | null =>
    [...groups.values()]
      .filter((g) => g.metric === metric)
      .sort((a, b) => b.values.size - a.values.size || (lastDay(b) > lastDay(a) ? 1 : -1))[0] ??
    null;

  let fallback: { view: SeasonsView } | null = null;
  for (const c of candidates) {
    const g = pick(c.metric);
    if (g === null) continue;
    const info: SeriesInfo = {
      noun: c.noun,
      source: sourceLabel(g.connection.provider),
      currency: g.currency,
    };
    const others = [
      ...new Set(
        [...groups.values()]
          .filter((o) => o.metric === c.metric && o.currency !== null && o.currency !== g.currency)
          .map((o) => o.currency as string),
      ),
    ];
    const view: SeasonsView = {
      result: seasonForecast(g.values, info, today),
      connect: row.connect,
      other_currencies: others,
      series_ref: { connection_id: g.connection.id, metric: g.metric },
    };
    if (view.result.status === "ready") return view;
    fallback ??= { view };
  }
  return fallback?.view ?? empty;
}
