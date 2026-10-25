// The market chart's loader — the only part of lib/charts that touches the
// database. Read-only: it reads measured series, the anomaly rows, the
// proposals and the profile's own answers, and hands them to the pure
// model (./model). Nothing here writes, calls a model or the network.
//
// Series rules (the anomaly layer's own): business-wide rows only, a row
// sliced by product, campaign or channel would double-count; money keeps
// its currency; a series is ONE connection's, never a sum across two (a
// Shopify store and a Stripe account can both report the same sale).

import { and, eq, gte, inArray, isNotNull, lte, or } from "drizzle-orm";
import { db } from "../../db";
import { anomalies, connections, metricObservations, proposals } from "../../db/schema";
import type { Basis } from "../../components/report/basis";
import { basisOf } from "../../components/report/basis";
import { loadCampaignSeries } from "../ads/proposals";
import { CAPACITY_KEY } from "../bookings/store";
import { BOOKINGS_IMPORT_PROVIDER } from "../bookings/source";
import { MONEY_METRICS, type MetricKey } from "../connectors/provider";
import { getProvider } from "../connectors/registry";
import { isProviderId } from "../connectors/scopes";
import { businessNoun } from "../core/business-noun";
import { readCurrentField } from "../profile/field-store";
import { loadStock, stockApplies } from "../stock/load";
import { STOCK_IMPORT_PROVIDER } from "../stock/import";
import { shiftDay } from "../anomaly/baseline";
import type {
  BookingDay,
  BookingsInput,
  CampaignInput,
  ComponentKey,
  WaitingProposal,
} from "./opportunity";
import { OPPORTUNITY, campaignWindows, windowEnding } from "./opportunity";
import type {
  MarketChartModel,
  MarketEvent,
  MarketInputs,
  PriceSeriesInput,
  VolumeSeriesInput,
} from "./model";
import { HISTORY_DAYS, MIN_DRAWN_DAYS, buildMarketModel } from "./model";
import { CHART_ARCHETYPES, archetypeFor } from "./profiles";
import type { BookingsChartModel, AdsChartModel } from "./small";
import { buildAdsChart, buildBookingsChart } from "./small";

export const TYPE_KEY = "identity.business_type";
export const SELLS_KEY = "identity.sells";

const BOOKING_METRICS: readonly MetricKey[] = [
  "appointments_completed.daily",
  "appointments_no_show.daily",
  "appointments_cancelled_late.daily",
  "booking_revenue.daily",
];

/** What each detected series is called in an event's label. */
const METRIC_NOUN: Readonly<Record<string, string>> = {
  "revenue.daily": "Revenue",
  "orders.daily": "Orders",
  "sessions.daily": "Website visits",
  "ad_spend.daily": "Ad spend",
  "ad_purchases.daily": "Ad purchases",
  "appointments_completed.daily": "Completed appointments",
  "booking_revenue.daily": "Booking revenue",
};

interface ConnInfo {
  id: string;
  provider: string;
  label: string;
  created_at: string;
}

/** Owner-facing name of a source: the provider's own label, or the import's. */
export function sourceLabel(provider: string): string {
  if (provider === BOOKINGS_IMPORT_PROVIDER) return "your bookings export";
  if (provider === STOCK_IMPORT_PROVIDER) return "your stock file";
  return isProviderId(provider) ? getProvider(provider).label : provider;
}

interface Group {
  conn: ConnInfo;
  metric: string;
  currency: string | null;
  values: Map<string, number>;
}

/** The group with the most measured days (latest last day breaks a tie). */
function best(groups: readonly Group[]): Group | null {
  let pick: Group | null = null;
  for (const g of groups) {
    if (g.values.size < MIN_DRAWN_DAYS) continue;
    if (
      pick === null ||
      g.values.size > pick.values.size ||
      (g.values.size === pick.values.size && lastDay(g) > lastDay(pick))
    ) {
      pick = g;
    }
  }
  return pick;
}

const lastDay = (g: Group) => [...g.values.keys()].sort().at(-1) ?? "";

export interface ChartsBundle {
  market: MarketChartModel;
  bookings: BookingsChartModel | null;
  ads: AdsChartModel | null;
}

/** Everything the signed-in charts draw for one business, as of `now`. */
export async function loadCharts(
  accountId: string,
  profileId: string,
  now: Date = new Date(),
): Promise<ChartsBundle> {
  const inputs = await loadMarketInputs(accountId, profileId, now);
  const market = buildMarketModel(inputs);
  const to =
    market.status === "drawn"
      ? market.window.to
      : (inputs.bookings?.days.at(-1)?.date ?? shiftDay(inputs.today, -1));
  const w = windowEnding(to);
  const ads = windowEnding(to, OPPORTUNITY.ads_window_days);
  return {
    market,
    bookings: buildBookingsChart(inputs.bookings, market, w),
    ads:
      inputs.campaigns === null ? null : buildAdsChart(campaignWindows(inputs.campaigns, ads), ads),
  };
}

export async function loadMarketInputs(
  accountId: string,
  profileId: string,
  now: Date = new Date(),
): Promise<MarketInputs> {
  const today = now.toISOString().slice(0, 10);
  const yesterday = shiftDay(today, -1);
  const from = shiftDay(yesterday, -(HISTORY_DAYS + 28 + 7));

  const type = await readCurrentField<unknown>(profileId, TYPE_KEY);
  const sells = await readCurrentField<unknown>(profileId, SELLS_KEY);
  const typeValue = type?.status === "answered" ? type.value : null;
  const sellsValue = sells?.status === "answered" ? sells.value : null;
  const archetype = archetypeFor(typeValue, sellsValue);
  const row = CHART_ARCHETYPES[archetype];

  const connRows = await db
    .select({
      id: connections.id,
      provider: connections.provider,
      created_at: connections.created_at,
    })
    .from(connections)
    .where(
      and(
        eq(connections.account_id, accountId),
        or(eq(connections.purpose, "measure"), eq(connections.purpose, "import")),
      ),
    );
  const conns = new Map<string, ConnInfo>(
    connRows.map((c) => [c.id, { ...c, label: sourceLabel(c.provider) }]),
  );

  const metrics = [
    ...new Set<MetricKey>([
      ...row.price.map((p) => p.metric),
      ...row.volume.map((v) => v.metric),
      ...BOOKING_METRICS,
    ]),
  ];
  const rows =
    conns.size === 0
      ? []
      : await db
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
              inArray(metricObservations.connection_id, [...conns.keys()]),
              inArray(metricObservations.metric_key, metrics),
              gte(metricObservations.period_date, from),
              lte(metricObservations.period_date, yesterday),
            ),
          );

  const groups = new Map<string, Group>();
  for (const r of rows) {
    if (!Object.keys(r.dimensions ?? {}).every((k) => k === "currency")) continue;
    const conn = conns.get(r.connection_id);
    if (!conn) continue;
    const isMoney = MONEY_METRICS.has(r.metric_key as MetricKey);
    if (isMoney && (r.value_minor === null || !r.currency)) continue;
    const key = `${r.connection_id}|${r.metric_key}|${isMoney ? r.currency : ""}`;
    const g = groups.get(key) ?? {
      conn,
      metric: r.metric_key,
      currency: isMoney ? r.currency : null,
      values: new Map<string, number>(),
    };
    g.values.set(r.period_date, isMoney ? Number(r.value_minor) : Number(r.value_num ?? 0));
    groups.set(key, g);
  }
  const ofMetric = (metric: string) => [...groups.values()].filter((g) => g.metric === metric);

  // The price: the first candidate with enough measured days.
  let price: PriceSeriesInput | null = null;
  let priceGroup: Group | null = null;
  for (const candidate of row.price) {
    const g = best(ofMetric(candidate.metric));
    if (g === null || g.currency === null) continue;
    priceGroup = g;
    price = {
      candidate,
      source: g.conn.label,
      series_id: `connector:${g.conn.provider}:${candidate.metric}`,
      currency: g.currency,
      values: g.values,
    };
    break;
  }
  const otherCurrencies = priceGroup
    ? [
        ...new Set(
          ofMetric(priceGroup.metric)
            .filter((g) => g.currency !== priceGroup!.currency && g.values.size >= MIN_DRAWN_DAYS)
            .map((g) => g.currency!),
        ),
      ]
    : [];

  // The volume: the same source as the price where it measures one.
  let volume: VolumeSeriesInput | null = null;
  for (const candidate of row.volume) {
    const all = ofMetric(candidate.metric);
    const same = all.filter((g) => g.conn.id === priceGroup?.conn.id);
    const g = best(same) ?? best(all);
    if (g === null) continue;
    volume = { candidate, source: g.conn.label, values: g.values };
    break;
  }

  // Bookings: the source with the most completed days, and its other series.
  let bookings: BookingsInput | null = null;
  const completed = best(ofMetric("appointments_completed.daily"));
  if (completed !== null) {
    const same = (metric: string) =>
      ofMetric(metric).filter((g) => g.conn.id === completed.conn.id);
    const noShow = same("appointments_no_show.daily")[0]?.values ?? new Map<string, number>();
    const lateGroup = same("appointments_cancelled_late.daily")[0] ?? null;
    const revenueGroups = same("booking_revenue.daily").sort(
      (a, b) => b.values.size - a.values.size,
    );
    const revenue = revenueGroups[0] ?? null;
    const days: BookingDay[] = [...completed.values.keys()].sort().map((date) => ({
      date,
      completed: completed.values.get(date) ?? 0,
      no_show: noShow.get(date) ?? 0,
      late: lateGroup ? (lateGroup.values.get(date) ?? 0) : null,
      revenue_minor: revenue ? (revenue.values.get(date) ?? null) : null,
    }));
    bookings = {
      source: completed.conn.label,
      series: `connector:${completed.conn.provider}`,
      currency: revenue?.currency ?? null,
      late_separated: lateGroup !== null,
      days,
    };
  }

  // The owner's own capacity: only an answer, never an assumption.
  const cap = await readCurrentField<unknown>(profileId, CAPACITY_KEY);
  const capBasis: Basis | null = cap
    ? basisOf({
        status: cap.status,
        source_kind: cap.source.kind,
        note: cap.note,
        confidence: cap.confidence,
      })
    : null;
  const capacity =
    cap?.status === "answered" &&
    typeof cap.value === "number" &&
    Number.isFinite(cap.value) &&
    cap.value > 0 &&
    (capBasis === "STATED" || capBasis === "ESTIMATED")
      ? { per_week: cap.value, basis: capBasis }
      : null;

  // Meta Ads, per campaign — null when it isn't connected at all.
  const meta = [...conns.values()].some((c) => c.provider === "meta_ads");
  let campaigns: CampaignInput[] | null = null;
  if (meta) {
    const end = price ? [...price.values.keys()].sort().at(-1)! : yesterday;
    const series = await loadCampaignSeries(
      accountId,
      shiftDay(end, -(OPPORTUNITY.window_days - 1)),
      end,
    );
    campaigns = series.map((s) => ({
      campaign_ref: s.campaign_ref,
      campaign_name: s.campaign_name,
      currency: s.currency,
      days: s.days.map((d) => ({
        date: d.date,
        spend_minor: d.spend_minor,
        value_minor: d.value_minor,
      })),
    }));
  }

  // Slow stock, where the business holds stock (STOCK_APPLIES is data).
  const skip: ComponentKey[] = [];
  let stock: MarketInputs["stock"] = null;
  if (row.components.includes("slow_stock")) {
    if (await stockApplies(profileId)) {
      const view = await loadStock(accountId, profileId, now);
      if (view.sources.length > 0) {
        stock = {
          items: view.slow.map((r) => ({
            name: r.item.name,
            cash_tied_minor: r.assessment.cash_tied_minor,
            currency: r.item.currency,
            cost_basis: r.item.cost_basis,
          })),
          as_of:
            view.sources
              .map((s) => s.as_of)
              .filter((d): d is string => d !== null)
              .sort()
              .at(-1) ?? null,
        };
      }
    } else {
      skip.push("slow_stock");
    }
  }

  const waiting = await waitingProposals(profileId, now);
  const events = await chartEvents(profileId, [
    ...new Set([priceGroup?.conn, completed?.conn].filter((c): c is ConnInfo => !!c)),
  ]);

  return {
    today,
    noun: businessNoun(typeValue),
    archetype,
    price,
    volume,
    bookings,
    capacity,
    campaigns,
    stock,
    waiting,
    events,
    other_currencies: otherCurrencies,
    skip,
  };
}

interface ScenarioCaseLike {
  profit_delta_monthly?: { amount_minor?: unknown; currency?: unknown } | null;
}

function moneyOf(
  c: ScenarioCaseLike | undefined,
): { amount_minor: number; currency: string } | null {
  const m = c?.profit_delta_monthly;
  if (!m || !Number.isSafeInteger(m.amount_minor) || typeof m.currency !== "string") return null;
  return { amount_minor: m.amount_minor as number, currency: m.currency };
}

/** The proposals waiting for the owner, with their own monthly cases. */
async function waitingProposals(profileId: string, now: Date): Promise<WaitingProposal[]> {
  const rows = await db
    .select({
      id: proposals.id,
      action: proposals.action,
      scenario: proposals.scenario,
      expires_at: proposals.expires_at,
    })
    .from(proposals)
    .where(and(eq(proposals.profile_id, profileId), eq(proposals.status, "pending")));
  return rows
    .filter((r) => Date.parse(r.expires_at) > now.getTime())
    .map((r) => {
      const scenario = (r.scenario ?? {}) as {
        base_case?: ScenarioCaseLike;
        upside_case?: ScenarioCaseLike;
      };
      const action = (r.action ?? {}) as { summary?: unknown };
      return {
        id: r.id,
        summary: typeof action.summary === "string" ? action.summary : "A waiting proposal",
        base: moneyOf(scenario.base_case),
        upside: moneyOf(scenario.upside_case),
      };
    });
}

/** Detected anomalies, what the owner approved, and the day each drawn source was connected. */
async function chartEvents(profileId: string, drawn: readonly ConnInfo[]): Promise<MarketEvent[]> {
  const events: MarketEvent[] = [];
  const found = await db
    .select({
      metric_key: anomalies.metric_key,
      direction: anomalies.direction,
      first_date: anomalies.first_date,
      run_days: anomalies.run_days,
      actual: anomalies.actual,
      expected: anomalies.expected,
      detail: anomalies.detail,
    })
    .from(anomalies)
    .where(eq(anomalies.profile_id, profileId));
  for (const a of found) {
    const actual = Number(a.actual);
    const expected = Number(a.expected);
    const pct = expected > 0 ? Math.round((Math.abs(actual - expected) / expected) * 100) : null;
    const noun = METRIC_NOUN[a.metric_key] ?? a.metric_key;
    events.push({
      date: a.first_date,
      kind: "anomaly",
      label:
        `${noun} ${a.direction === "drop" ? "fell" : "rose"}` +
        (pct === null
          ? ""
          : ` ${pct}% ${a.direction === "drop" ? "below" : "above"} the usual level`),
      detail: a.detail,
    });
  }
  const decided = await db
    .select({
      action: proposals.action,
      status: proposals.status,
      decided_at: proposals.decided_at,
    })
    .from(proposals)
    .where(
      and(
        eq(proposals.profile_id, profileId),
        inArray(proposals.status, ["approved", "executed"]),
        isNotNull(proposals.decided_at),
      ),
    );
  for (const p of decided) {
    const action = (p.action ?? {}) as { summary?: unknown };
    const summary = typeof action.summary === "string" ? action.summary : "a proposal";
    events.push({
      date: p.decided_at!.slice(0, 10),
      kind: "approved",
      label: summary,
      detail: `You approved “${summary}”${p.status === "executed" ? "; it has run" : "; it hasn't run yet"}.`,
    });
  }
  for (const c of drawn) {
    events.push({
      date: c.created_at.slice(0, 10),
      kind: "connected",
      label:
        c.provider === BOOKINGS_IMPORT_PROVIDER
          ? "Bookings first imported"
          : `${c.label.charAt(0).toUpperCase()}${c.label.slice(1)} connected`,
      detail: `Read from ${c.created_at.slice(0, 10)} on; the days before it came in with the first read.`,
    });
  }
  return events;
}
