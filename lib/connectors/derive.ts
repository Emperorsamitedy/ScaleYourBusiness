// Observations → profile facts — P2-05, extended by P2-16 and P2-18/21.
//
// Daily observations are the provider's raw word; the profile wants
// monthly figures. This module sums a window of days into the facts the
// economics engine reads, and writes each as a Field<T> through the
// ordinary supersession path, so:
//
//   · the owner's estimate is superseded, never overwritten (rule 3): it
//     stays in history with its owner_input source, and the report shows
//     "you estimated X; the connector measured Y" (rule 11);
//   · the measured fact is status "inferred" with derived_from naming the
//     observation series and a method stating the exact window and count
//     (rule 6) — a number nobody has to take on faith;
//   · currencies never blend (rule 1): a window holding two currencies
//     for one metric is a refusal, and the owner's figure stays current.
//
// Three kinds of fact come out:
//
//   · business-wide: monthly revenue, order count, ad spend, website sessions;
//   · a ratio (P2-21): cost per purchase, ad spend over the purchases the ad
//     platform attributes to it, refused when there are no purchases;
//   · per entity: units sold a month for every offer matched to a store
//     product (P2-16), sessions a month for every channel matched to an
//     analytics channel (P2-18). An unmatched entity gets no outcome at
//     all: a gap, not a guess.
//
// Re-running over an unchanged window writes nothing: a daily cron must
// not turn one fact into 365 identical history rows.
//
// Confidence is the §8.1 connector base (0.95), not min(inputs) × 0.9 —
// the inputs are measurements, not other inferences.

import { and, desc, eq, gte, inArray, lte, ne, notInArray, or } from "drizzle-orm";
import { db } from "../../db";
import {
  businessProfiles,
  channels,
  connections,
  metricObservations,
  offers,
} from "../../db/schema";
import { createField } from "../core/field";
import { fieldId } from "../core/ids";
import type { ISODate, ISODateTime } from "../core/iso";
import { isoDate, isoDateTime } from "../core/iso";
import type { Money } from "../core/money";
import { money } from "../core/money";
import { readCurrentField, writeField } from "../profile/field-store";
import type { MappingKind } from "./mapping";
import { mappingKey } from "./mapping";
import { EXECUTE_READ_PROVIDERS } from "./execute-reads";
import { connectorSeriesId } from "./measured";
import type { MetricKey } from "./provider";
import { STOCK_METRICS } from "./provider";
import { ConnectorError, canonicalDimensions } from "./service";

/** data-model §8.1: connector-sourced facts start at 0.95. */
export const CONNECTOR_CONFIDENCE = 0.95;
/** "Monthly" = the trailing 30 observed days, ending at the latest observation. */
export const DEFAULT_WINDOW_DAYS = 30;

export interface DeriveWindow {
  from: ISODate;
  /** Inclusive. */
  to: ISODate;
}

export type DeriveOutcome =
  | { field_key: string; outcome: "written"; record_id: string; value: unknown }
  | { field_key: string; outcome: "unchanged"; value: unknown }
  | { field_key: string; outcome: "refused"; reason: string };

interface Derivation {
  field_key: string;
  metric: MetricKey;
  kind: "money" | "count";
}

/** The business-wide facts measurement can supply. Ratios and per-entity facts are derived separately. */
export const DERIVATIONS: readonly Derivation[] = [
  { field_key: "revenue.monthly_revenue", metric: "revenue.daily", kind: "money" },
  { field_key: "revenue.order_count_monthly", metric: "orders.daily", kind: "count" },
  { field_key: "marketing.monthly_ad_spend", metric: "ad_spend.daily", kind: "money" },
  { field_key: "presence.monthly_sessions", metric: "sessions.daily", kind: "count" },
];

/** P2-21: ad spend ÷ attributed purchases, written when both were measured. */
export const COST_PER_PURCHASE_KEY = "marketing.cost_per_purchase";

/** Per-entity measured facts, as written here. */
export const ENTITY_MEASURE_KEY =
  /^(offers\.[^.]+\.volume_period|channels\.[^.]+\.monthly_sessions)$/;
/** @deprecated use ENTITY_MEASURE_KEY */
export const VOLUME_KEY = ENTITY_MEASURE_KEY;

const ENTITY_MEASURES: readonly {
  kind: MappingKind;
  metric: MetricKey;
  dimension: "product_ref" | "channel_ref";
  field: "volume_period" | "monthly_sessions";
  /** The metric whose days count as "the source was read" for the window. */
  coverage: MetricKey;
  noun: string;
}[] = [
  {
    kind: "product",
    metric: "units.daily",
    dimension: "product_ref",
    field: "volume_period",
    coverage: "orders.daily",
    noun: "units sold of the matched product",
  },
  {
    kind: "channel",
    metric: "sessions.daily",
    dimension: "channel_ref",
    field: "monthly_sessions",
    coverage: "sessions.daily",
    noun: "sessions from the matched traffic channel",
  },
];

const DAY_MS = 86_400_000;

export function trailingWindow(to: ISODate, days = DEFAULT_WINDOW_DAYS): DeriveWindow {
  const end = new Date(`${to}T00:00:00Z`);
  const start = new Date(end.getTime() - (days - 1) * DAY_MS);
  return { from: isoDate(start.toISOString().slice(0, 10)), to };
}

/**
 * The most recent day the connection has any daily figure for. Stock
 * snapshots (feature 34) are left out: they are dated the day they were
 * read, today, while every daily series ends yesterday, and a window
 * ending on a day with no sales figures would read as a day of zero.
 */
export async function latestObservedDate(connectionId: string): Promise<ISODate | null> {
  const [row] = await db
    .select({ period_date: metricObservations.period_date })
    .from(metricObservations)
    .where(
      and(
        eq(metricObservations.connection_id, connectionId),
        notInArray(metricObservations.metric_key, [...STOCK_METRICS]),
      ),
    )
    .orderBy(desc(metricObservations.period_date))
    .limit(1);
  return row ? isoDate(row.period_date) : null;
}

/**
 * Order-insensitive deep equality.
 *
 * Postgres normalises JSONB key order: a Money written as
 * {amount_minor, currency} reads back as {currency, amount_minor}. So
 * JSON.stringify is the wrong equality test here — it would report every
 * unchanged day as a change and turn the daily cron into 365 identical
 * history rows, which is precisely what rule 3 makes expensive.
 */
function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => sameValue(item, b[i]));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every(
    (k) => Object.prototype.hasOwnProperty.call(right, k) && sameValue(left[k], right[k]),
  );
}

type ConnectionRow = typeof connections.$inferSelect;

/** Write a measured fact unless the current one already says exactly this. Shared with lib/bookings/store.ts. */
export async function writeMeasured(args: {
  profileId: string;
  fieldKey: string;
  value: unknown;
  provider: string;
  /** P2-20: a fact measured by several providers together; derived_from names each one's series. */
  providers?: readonly string[];
  metrics: readonly MetricKey[];
  method: string;
  window: DeriveWindow;
  recordedAt: ISODateTime;
  note: string;
}): Promise<DeriveOutcome> {
  const current = await readCurrentField<unknown>(args.profileId, args.fieldKey);
  if (
    current &&
    current.status === "inferred" &&
    current.source.kind === "inferred" &&
    current.source.method === args.method &&
    sameValue(current.value, args.value)
  ) {
    return { field_key: args.fieldKey, outcome: "unchanged", value: args.value };
  }

  const field = createField<unknown>({
    id: fieldId(args.fieldKey),
    value: args.value,
    status: "inferred",
    confidence: CONNECTOR_CONFIDENCE,
    source: {
      kind: "inferred",
      // Names the observation SERIES, not a profile field: the inputs live in
      // metric_observations under this connection. The "connector:" prefix is
      // what marks the fact as measured (lib/connectors/measured.ts) for the
      // report and the economics.
      derived_from: (args.providers ?? [args.provider]).flatMap((p) =>
        args.metrics.map((m) => fieldId(connectorSeriesId(p, m))),
      ),
      method: args.method,
    },
    observed_at: isoDateTime(`${args.window.to}T23:59:59Z`),
    recorded_at: args.recordedAt,
    note: args.note,
  });
  const record_id = await writeField(args.profileId, field);
  return { field_key: args.fieldKey, outcome: "written", record_id, value: args.value };
}

interface WholeRows {
  rows: {
    period_date: string;
    value_minor: number | null;
    currency: string | null;
    value_num: string | null;
  }[];
  days: number;
}

/** Business-wide rows of one metric in the window: not sliced by product, channel or offer. */
async function wholeRows(
  connectionId: string,
  metric: MetricKey,
  w: DeriveWindow,
): Promise<WholeRows> {
  const rows = await db
    .select({
      period_date: metricObservations.period_date,
      value_minor: metricObservations.value_minor,
      currency: metricObservations.currency,
      value_num: metricObservations.value_num,
      dimensions: metricObservations.dimensions,
    })
    .from(metricObservations)
    .where(
      and(
        eq(metricObservations.connection_id, connectionId),
        eq(metricObservations.metric_key, metric),
        gte(metricObservations.period_date, w.from),
        lte(metricObservations.period_date, w.to),
      ),
    );
  // A row sliced by product, offer or channel is part of a total already
  // counted, and would double it.
  const whole = rows.filter((r) =>
    Object.keys(r.dimensions ?? {}).every((key) => key === "currency"),
  );
  return { rows: whole, days: new Set(whole.map((r) => r.period_date)).size };
}

type MoneyTotal = { ok: true; value: Money } | { ok: false; reason: string };

function totalMoney(metric: MetricKey, rows: WholeRows["rows"]): MoneyTotal {
  const currencies = [...new Set(rows.map((r) => r.currency ?? "?"))].sort();
  const currency = currencies[0];
  if (currencies.length !== 1 || currency === undefined) {
    return {
      ok: false,
      reason: `currencies never blend: ${metric} holds ${currencies.join(", ")} in the window`,
    };
  }
  return {
    ok: true,
    value: money(
      rows.reduce((acc, r) => acc + (r.value_minor ?? 0), 0),
      currency,
    ),
  };
}

const totalCount = (rows: WholeRows["rows"]): number =>
  rows.reduce((acc, r) => acc + Number(r.value_num ?? 0), 0);

/** P2-21: cost per attributed purchase, for ad platform connections. */
async function deriveCostPerPurchase(
  conn: ConnectionRow,
  profileId: string,
  w: DeriveWindow,
  recordedAt: ISODateTime,
): Promise<DeriveOutcome | null> {
  const spend = await wholeRows(conn.id, "ad_spend.daily", w);
  if (spend.rows.length === 0) return null; // not an ad platform: nothing to say
  const purchases = await wholeRows(conn.id, "ad_purchases.daily", w);
  if (purchases.rows.length === 0) return null; // spend without attribution data (the fixture)

  const total = totalMoney("ad_spend.daily", spend.rows);
  if (!total.ok)
    return { field_key: COST_PER_PURCHASE_KEY, outcome: "refused", reason: total.reason };
  const count = totalCount(purchases.rows);
  if (count <= 0) {
    return {
      field_key: COST_PER_PURCHASE_KEY,
      outcome: "refused",
      reason: `${conn.provider} attributed no purchases between ${w.from} and ${w.to}, so there is no cost per purchase to measure`,
    };
  }
  return writeMeasured({
    profileId,
    fieldKey: COST_PER_PURCHASE_KEY,
    value: money(Math.round(total.value.amount_minor / count), total.value.currency),
    provider: conn.provider,
    metrics: ["ad_spend.daily", "ad_purchases.daily"],
    method:
      `sum(ad_spend.daily) ÷ sum(ad_purchases.daily) over ${w.from}..${w.to} ` +
      `(${spend.days} days, ${count} attributed purchases) from ${conn.provider} connection ${conn.id}`,
    window: w,
    recordedAt,
    note: `Measured by ${conn.provider}: ad spend divided by the purchases it attributed, ${w.from} to ${w.to}.`,
  });
}

/**
 * P2-20: with more than one ad platform measuring spend (Meta's measure
 * connection, Google Ads' execute connection), the business's monthly ad
 * spend is their SUM over the window — never whichever synced last, which
 * would flip the fact between platforms every night. One currency only
 * (rule 1): two platforms billing in different currencies are a refusal,
 * and the current fact stands. Null when this connection is the account's
 * only ad-spend source in the window: the ordinary single-source path runs.
 */
async function deriveCombinedAdSpend(
  conn: ConnectionRow,
  profileId: string,
  fieldKey: string,
  w: DeriveWindow,
  recordedAt: ISODateTime,
): Promise<DeriveOutcome | null> {
  const siblings = await db
    .select()
    .from(connections)
    .where(
      and(
        eq(connections.account_id, conn.account_id),
        or(
          eq(connections.purpose, "measure"),
          and(
            eq(connections.purpose, "execute"),
            inArray(connections.provider, [...EXECUTE_READ_PROVIDERS]),
          ),
        ),
        ne(connections.status, "disconnected"),
      ),
    )
    .orderBy(connections.created_at);
  const sources: { conn: ConnectionRow; whole: WholeRows }[] = [];
  for (const c of siblings) {
    const whole = await wholeRows(c.id, "ad_spend.daily", w);
    if (whole.rows.length > 0) sources.push({ conn: c, whole });
  }
  if (sources.length < 2 || !sources.some((s) => s.conn.id === conn.id)) return null;
  const total = totalMoney(
    "ad_spend.daily",
    sources.flatMap((s) => s.whole.rows),
  );
  if (!total.ok) return { field_key: fieldKey, outcome: "refused", reason: total.reason };
  const parts = sources.map(
    (s) =>
      `${s.conn.provider} connection ${s.conn.id} (${s.whole.days} days, ${s.whole.rows.length} observations)`,
  );
  const providers = [...new Set(sources.map((s) => s.conn.provider))];
  return writeMeasured({
    profileId,
    fieldKey,
    value: total.value,
    provider: providers[0] as string,
    providers,
    metrics: ["ad_spend.daily"],
    method: `sum(ad_spend.daily) over ${w.from}..${w.to} across ${parts.join(" + ")}`,
    window: w,
    recordedAt,
    note: `Measured by ${providers.join(" and ")} together, ${w.from} to ${w.to}.`,
  });
}

/**
 * P2-16 / P2-18: a monthly figure for each entity matched to one of this
 * provider's items. Zero is a real measurement only when the provider was
 * actually read for the window; otherwise it is a refusal.
 */
async function deriveEntityMeasures(
  conn: ConnectionRow,
  profileId: string,
  w: DeriveWindow,
  recordedAt: ISODateTime,
): Promise<DeriveOutcome[]> {
  const outcomes: DeriveOutcome[] = [];
  for (const measure of ENTITY_MEASURES) {
    const table = measure.kind === "product" ? offers : channels;
    const spine = await db
      .select({ id: table.id })
      .from(table)
      .where(eq(table.profile_id, profileId))
      .orderBy(table.created_at);
    if (spine.length === 0) continue;

    const matched: { id: string; ref: string }[] = [];
    for (const { id } of spine) {
      const mapping = await readCurrentField<unknown>(
        profileId,
        mappingKey(id, conn.provider, measure.kind),
      );
      const ref =
        mapping?.status === "answered"
          ? (mapping.value as Record<string, unknown> | null)?.[measure.dimension]
          : undefined;
      if (typeof ref === "string") matched.push({ id, ref }); // unmatched: a gap, not a guess
    }
    if (matched.length === 0) continue;

    const coverage = await wholeRows(conn.id, measure.coverage, w);
    for (const { id, ref } of matched) {
      const fieldKey = `${measure.kind === "product" ? "offers" : "channels"}.${id}.${measure.field}`;
      if (coverage.days === 0) {
        outcomes.push({
          field_key: fieldKey,
          outcome: "refused",
          reason: `no ${measure.coverage} read between ${w.from} and ${w.to}`,
        });
        continue;
      }
      const rows = await db
        .select({ value_num: metricObservations.value_num })
        .from(metricObservations)
        .where(
          and(
            eq(metricObservations.connection_id, conn.id),
            eq(metricObservations.metric_key, measure.metric),
            eq(metricObservations.dimension_key, canonicalDimensions({ [measure.dimension]: ref })),
            gte(metricObservations.period_date, w.from),
            lte(metricObservations.period_date, w.to),
          ),
        );
      outcomes.push(
        await writeMeasured({
          profileId,
          fieldKey,
          value: rows.reduce((acc, r) => acc + Number(r.value_num ?? 0), 0),
          provider: conn.provider,
          metrics: [measure.metric],
          method:
            `sum(${measure.metric} for ${ref}) over ${w.from}..${w.to} ` +
            `(${coverage.days} days read) from ${conn.provider} connection ${conn.id}`,
          window: w,
          recordedAt,
          note: `Measured by ${conn.provider}: ${measure.noun}, ${w.from} to ${w.to}.`,
        }),
      );
    }
  }
  return outcomes;
}

/**
 * Derive the monthly facts for a connection's account from its
 * observations over `window` (default: trailing 30 days up to the latest
 * observation). One outcome per business-wide derivation, plus the ratio
 * and per-entity facts where they apply; never throws for a missing
 * metric — that is a refusal, reported.
 */
export async function deriveFactsFromObservations(
  connectionId: string,
  window?: DeriveWindow,
): Promise<DeriveOutcome[]> {
  const [conn] = await db.select().from(connections).where(eq(connections.id, connectionId));
  if (!conn) throw new ConnectorError("connection not found", 404);

  const [profile] = await db
    .select({ id: businessProfiles.id })
    .from(businessProfiles)
    .where(eq(businessProfiles.account_id, conn.account_id));
  if (!profile) {
    return DERIVATIONS.map((d) => ({
      field_key: d.field_key,
      outcome: "refused",
      reason: "the account has no business profile to write facts into",
    }));
  }

  const latest = await latestObservedDate(connectionId);
  const w = window ?? (latest ? trailingWindow(latest) : null);
  if (!w) {
    return DERIVATIONS.map((d) => ({
      field_key: d.field_key,
      outcome: "refused",
      reason: "no observations yet",
    }));
  }

  const now = isoDateTime(new Date().toISOString());
  const outcomes: DeriveOutcome[] = [];

  for (const d of DERIVATIONS) {
    // P2-20: ad spend is the business's across every ad platform it measures.
    if (d.metric === "ad_spend.daily") {
      const combined = await deriveCombinedAdSpend(conn, profile.id, d.field_key, w, now);
      if (combined !== null) {
        outcomes.push(combined);
        continue;
      }
    }
    const whole = await wholeRows(connectionId, d.metric, w);
    if (whole.rows.length === 0) {
      outcomes.push({
        field_key: d.field_key,
        outcome: "refused",
        reason: `no ${d.metric} observations between ${w.from} and ${w.to}`,
      });
      continue;
    }

    let value: Money | number;
    if (d.kind === "money") {
      const total = totalMoney(d.metric, whole.rows);
      if (!total.ok) {
        outcomes.push({ field_key: d.field_key, outcome: "refused", reason: total.reason });
        continue;
      }
      value = total.value;
    } else {
      value = totalCount(whole.rows);
    }

    outcomes.push(
      await writeMeasured({
        profileId: profile.id,
        fieldKey: d.field_key,
        value,
        provider: conn.provider,
        metrics: [d.metric],
        method:
          `sum(${d.metric}) over ${w.from}..${w.to} ` +
          `(${whole.days} days, ${whole.rows.length} observations) from ${conn.provider} connection ${conn.id}`,
        window: w,
        recordedAt: now,
        note: `Measured by ${conn.provider}, ${w.from} to ${w.to}.`,
      }),
    );
  }

  const ratio = await deriveCostPerPurchase(conn, profile.id, w, now);
  if (ratio !== null) outcomes.push(ratio);
  outcomes.push(...(await deriveEntityMeasures(conn, profile.id, w, now)));
  return outcomes;
}
