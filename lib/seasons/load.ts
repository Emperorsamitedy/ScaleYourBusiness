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
import { BOOKINGS_IMPORT_PROVIDER } from "../bookings/source";
import { SELLS_KEY, TYPE_KEY, sourceLabel } from "../charts/load";
import type { ArchetypeKey } from "../charts/profiles";
import { CHART_ARCHETYPES, archetypeFor } from "../charts/profiles";
import { MONEY_METRICS, type MetricKey } from "../connectors/provider";
import { readCurrentField } from "../profile/field-store";
import { STOCK_IMPORT_PROVIDER } from "../stock/import";
import type { SeasonResult, SeasonWords, SeriesInfo } from "./forecast";
import { SEASONS, englishSeasonWords, rewordSeason, seasonForecast } from "./forecast";

export interface SeasonsView {
  result: SeasonResult;
  /** What to connect when nothing is measured, in the owner's words (the archetype's). */
  connect: string;
  /** The archetype the connect line is (L-4b: said again in the reader's language). */
  archetype?: ArchetypeKey;
  /** Currencies of the same series left out, when the business is paid in more than one. */
  other_currencies: string[];
  /** Which connection and metric the series is (idea 54 grades a week against the same one). */
  series_ref?: { connection_id: string; metric: MetricKey } | null;
}

/** The series nouns the chart profiles name (lib/charts/profiles), by metric: catalogue keys. */
const NOUN_KEY: Readonly<Record<string, string>> = {
  "revenue.daily": "revenue",
  "booking_revenue.daily": "bookingRevenue",
  "orders.daily": "orders",
  "appointments_completed.daily": "appointments",
  "sessions.daily": "visits",
};

/** The sources SYB names in its own words (an import); any other is the provider's own name. */
const SOURCE_KEY: Readonly<Record<string, string>> = {
  [BOOKINGS_IMPORT_PROVIDER]: "bookingsExport",
  [STOCK_IMPORT_PROVIDER]: "stockFile",
};

/** A connection's source label in the reader's words; a provider's brand stays its own. */
export function sourceLabelIn(
  provider: string,
  { tr }: SeasonWords = englishSeasonWords(),
): string {
  const key = SOURCE_KEY[provider];
  return key ? tr(`source.${key}`) : sourceLabel(provider);
}

/** A series' noun and source in the reader's words, where SYB chose them. */
export function seriesIn(
  series: SeriesInfo,
  words: SeasonWords = englishSeasonWords(),
): SeriesInfo {
  const noun = series.metric ? NOUN_KEY[series.metric] : undefined;
  return {
    ...series,
    noun: noun ? words.tr(`noun.${noun}`) : series.noun,
    source: series.provider ? sourceLabelIn(series.provider, words) : series.source,
  };
}

/**
 * The view as the screen says it, in `words` (L-4b): the same figures,
 * the sentences, the series noun and source and the connect line in the
 * reader's language. The view loadSeasons returns stays English — it is
 * what lib/forecasts records (rule 7). Pure.
 */
export function seasonsInWords(view: SeasonsView, words: SeasonWords): SeasonsView {
  const connect = view.archetype ? words.tr(`connect.${view.archetype}`) : view.connect;
  const r = view.result;
  if (r.status === "no_data") return { ...view, connect };
  return {
    ...view,
    connect,
    result: rewordSeason({ ...r, series: seriesIn(r.series, words) }, words),
  };
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
  const archetype = archetypeFor(
    type?.status === "answered" ? type.value : null,
    sells?.status === "answered" ? sells.value : null,
  );
  const row = CHART_ARCHETYPES[archetype];
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
    archetype,
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
      metric: c.metric,
      provider: g.connection.provider,
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
      archetype,
      other_currencies: others,
      series_ref: { connection_id: g.connection.id, metric: g.metric },
    };
    if (view.result.status === "ready") return view;
    fallback ??= { view };
  }
  return fallback?.view ?? empty;
}
