// The cash forecast's database side — Phase 5 Session B. READ-ONLY (rule
// 26): the profile's current facts (cash today, buffer, debt, how customers
// pay, the costs and offers lists) and the measured daily series the
// connectors already wrote (rule 9's read scopes). It inserts, updates and
// deletes nothing, calls no model and nothing outside the database
// (lib/cash/fence.test.ts holds every file here to that).
//
// Which series, as data (rule 4): the market chart's archetype row
// (lib/charts/profiles) names the money series a kind of business is read
// by, in order, and its volume series. One connection's series only: a shop
// and a payment account can both report the same sale, so two sources are
// never added together. Business-wide rows only, as everywhere else. The
// series in the cash's currency wins; others are named and left out.

import { and, eq, gte, inArray, isNull, like, lte, or } from "drizzle-orm";
import { db } from "../../db";
import { connections, costItems, fieldRecords, metricObservations, offers } from "../../db/schema";
import { SELLS_KEY, TYPE_KEY, sourceLabel } from "../charts/load";
import { CHART_ARCHETYPES, archetypeFor } from "../charts/profiles";
import type { Field } from "../core/field";
import { MONEY_METRICS, type MetricKey } from "../connectors/provider";
import type { FieldRecordRow } from "../profile/field-codec";
import { rowToField } from "../profile/field-codec";
import { SEASONS, addDays } from "../seasons/forecast";
import { codesOf, costLines, countFactOf, moneyAnswer, offerLines } from "./inputs";
import {
  BUFFER_KEY,
  CASH_KEY,
  DEBT_KEY,
  ORDERS_MONTHLY_KEY,
  PAYMENT_METHODS_KEY,
  PAYMENT_PROVIDER_KEY,
} from "./keys";
import type { CashInputs, CountSeries, DailySeries } from "./model";
import { CASH } from "./model";

/** Days read back: a year of weeks, the growth weeks a year before them, and a margin. */
const READ_DAYS = SEASONS.year_weeks * 7 + CASH.growth_weeks * 7 + 14;

interface Group {
  connection: { id: string; provider: string };
  metric: MetricKey;
  currency: string | null;
  values: Map<string, number>;
}

/** The profile's current facts under the keys the forecast reads. */
async function currentFacts(profileId: string): Promise<Map<string, Field<unknown>>> {
  const rows = await db
    .select()
    .from(fieldRecords)
    .where(
      and(
        eq(fieldRecords.profile_id, profileId),
        isNull(fieldRecords.superseded_at),
        or(
          like(fieldRecords.field_key, "costs.%"),
          like(fieldRecords.field_key, "offers.%"),
          inArray(fieldRecords.field_key, [
            TYPE_KEY,
            SELLS_KEY,
            PAYMENT_METHODS_KEY,
            PAYMENT_PROVIDER_KEY,
            ORDERS_MONTHLY_KEY,
          ]),
        ),
      ),
    );
  const facts = new Map<string, Field<unknown>>();
  for (const row of rows) {
    facts.set(row.field_key, rowToField<unknown>(row as unknown as FieldRecordRow));
  }
  return facts;
}

/** Everything the forecast needs for one business, as of `now`. */
export async function loadCashInputs(
  accountId: string,
  profileId: string,
  now: Date = new Date(),
): Promise<CashInputs> {
  const today = now.toISOString().slice(0, 10);
  const facts = await currentFacts(profileId);
  const cash = moneyAnswer(facts.get(CASH_KEY));
  const row =
    CHART_ARCHETYPES[
      archetypeFor(
        facts.get(TYPE_KEY)?.status === "answered" ? facts.get(TYPE_KEY)!.value : null,
        facts.get(SELLS_KEY)?.status === "answered" ? facts.get(SELLS_KEY)!.value : null,
      )
    ];

  const [items, offerRows, conns] = await Promise.all([
    db
      .select({ id: costItems.id, bucket: costItems.bucket })
      .from(costItems)
      .where(eq(costItems.profile_id, profileId)),
    db.select({ id: offers.id }).from(offers).where(eq(offers.profile_id, profileId)),
    db
      .select({ id: connections.id, provider: connections.provider })
      .from(connections)
      .where(
        and(
          eq(connections.account_id, accountId),
          or(eq(connections.purpose, "measure"), eq(connections.purpose, "import")),
        ),
      ),
  ]);

  const priceMetrics = row.price.map((p) => p.metric).filter((m) => MONEY_METRICS.has(m));
  const volumeMetrics = row.volume.map((v) => v.metric).filter((m) => !MONEY_METRICS.has(m));
  const groups = new Map<string, Group>();
  if (conns.length > 0) {
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
          inArray(metricObservations.metric_key, [...priceMetrics, ...volumeMetrics]),
          gte(metricObservations.period_date, addDays(today, -READ_DAYS)),
          lte(metricObservations.period_date, addDays(today, -1)),
        ),
      );
    for (const r of rows) {
      if (!Object.keys(r.dimensions ?? {}).every((k) => k === "currency")) continue;
      const connection = byId.get(r.connection_id);
      if (!connection) continue;
      const metric = r.metric_key as MetricKey;
      const isMoney = MONEY_METRICS.has(metric);
      if (isMoney && (r.value_minor === null || !r.currency)) continue;
      const currency = isMoney ? r.currency!.toUpperCase() : null;
      const key = `${r.connection_id}|${metric}|${currency ?? ""}`;
      const g = groups.get(key) ?? { connection, metric, currency, values: new Map() };
      g.values.set(r.period_date, isMoney ? Number(r.value_minor) : Number(r.value_num ?? 0));
      groups.set(key, g);
    }
  }

  // The money series: the archetype's first metric with data; the cash's currency first.
  const want = cash.status === "known" ? cash.fact.currency : null;
  let revenue: DailySeries | null = null;
  let others: string[] = [];
  let picked: Group | null = null;
  for (const p of row.price) {
    const candidates = [...groups.values()].filter((g) => g.metric === p.metric);
    if (candidates.length === 0) continue;
    candidates.sort(
      (a, b) =>
        Number(b.currency === want) - Number(a.currency === want) || b.values.size - a.values.size,
    );
    picked = candidates[0]!;
    revenue = {
      source: sourceLabel(picked.connection.provider),
      provider: picked.connection.provider,
      noun: p.noun,
      currency: picked.currency!,
      values: picked.values,
    };
    others = [
      ...new Set(
        candidates.filter((c) => c.currency !== picked!.currency).map((c) => c.currency as string),
      ),
    ];
    break;
  }
  let volume: CountSeries | null = null;
  if (picked) {
    for (const v of row.volume) {
      const g = groups.get(`${picked.connection.id}|${v.metric}|`);
      if (g && g.values.size > 0) {
        volume = { noun: v.word, values: g.values };
        break;
      }
    }
  }

  return {
    today,
    cash,
    buffer: moneyAnswer(facts.get(BUFFER_KEY)),
    debt: moneyAnswer(facts.get(DEBT_KEY)),
    revenue,
    volume,
    orders_month: countFactOf(facts.get(ORDERS_MONTHLY_KEY)),
    payout: {
      provider: codesOf(facts.get(PAYMENT_PROVIDER_KEY))?.[0] ?? null,
      methods: codesOf(facts.get(PAYMENT_METHODS_KEY)),
    },
    costs: costLines(facts, items),
    offers: offerLines(
      facts,
      offerRows.map((o) => o.id),
    ),
    connect: row.connect,
    other_currencies: others,
  };
}
