// Reading slow stock from what was measured — feature 34.
//
// Sources are data, not a list of platforms: every measure connection
// whose provider can take a stock snapshot (Provider.readStock), plus the
// account's stock-file import connection. Each contributes its LATEST
// snapshot; a store's daily units sold (units.daily, already measured
// since P2-16) give the rate of sale, and its orders.daily rows say which
// days the sync covered, so a quiet item is told apart from an unmeasured
// one. Where a store has no unit cost (WooCommerce core), the owner's own
// cost for the matched offer stands in, labelled "stated", never measured.
//
// Who sees it is data too (rule 4): STOCK_APPLIES (./applies) is a
// ConditionExpr over the bank's own answers, evaluated by the resolver's
// evaluator.

import { and, eq, gte, inArray, ne, or } from "drizzle-orm";
import { db } from "../../db";
import { connections, metricObservations, offers } from "../../db/schema";
import { evaluate } from "../conditions/evaluate";
import { mappingKey } from "../connectors/mapping";
import { getProvider } from "../connectors/registry";
import { isProviderId } from "../connectors/scopes";
import type { Money } from "../core/money";
import { readCurrentField } from "../profile/field-store";
import { buildConditionContext } from "../resolver/applicability";
import type { RankedItem, StockItem } from "./assess";
import { STOCK, assessItem, rankSlow, shiftDay } from "./assess";
import { STOCK_APPLIES } from "./applies";
import { STOCK_IMPORT_PROVIDER } from "./import";

export { STOCK_APPLIES };

/** The owner's own estimate of dead stock (1.4.1.2.1f), shown beside the measured figure (rule 11). */
export const DEAD_STOCK_KEY = "offers.physical.inventory.dead_stock_value";

export async function stockApplies(profileId: string): Promise<boolean> {
  return evaluate(STOCK_APPLIES, await buildConditionContext(profileId));
}

/** Store providers are the ones that can take a stock snapshot: read from the registry. */
export function isStockProvider(provider: string): boolean {
  return isProviderId(provider) && getProvider(provider).readStock !== undefined;
}

export interface StockSource {
  connection_id: string;
  provider: string;
  label: string;
  /** The latest snapshot's day, or null when none has landed yet. */
  as_of: string | null;
  items: number;
}

export interface StockView {
  today: string;
  sources: StockSource[];
  /** Every item read, judged. */
  items: RankedItem[];
  /** The flagged ones, most cash tied up first (rankSlow). */
  slow: RankedItem[];
  /** The owner's own estimate of dead stock, when they gave one (rule 11). */
  stated_dead_stock: Money | null;
}

interface OfferInfo {
  id: string;
  name: string;
  cost: Money | null;
  refs: Map<string, string>; // provider → product_ref
}

async function offerInfo(profileId: string, providers: readonly string[]): Promise<OfferInfo[]> {
  const spine = await db
    .select({ id: offers.id })
    .from(offers)
    .where(eq(offers.profile_id, profileId))
    .orderBy(offers.created_at);
  const out: OfferInfo[] = [];
  for (const { id } of spine) {
    const name = await readCurrentField<unknown>(profileId, `offers.${id}.name`);
    const cost = await readCurrentField<Money>(profileId, `offers.${id}.cost_to_deliver`);
    const refs = new Map<string, string>();
    for (const p of providers) {
      const m = await readCurrentField<{ product_ref?: unknown }>(profileId, mappingKey(id, p));
      if (m?.status === "answered" && typeof m.value?.product_ref === "string") {
        refs.set(p, m.value.product_ref);
      }
    }
    const c = cost?.status === "answered" ? cost.value : null;
    out.push({
      id,
      name: typeof name?.value === "string" ? name.value : "Unnamed offer",
      cost: c && Number.isSafeInteger(c.amount_minor) && typeof c.currency === "string" ? c : null,
      refs,
    });
  }
  return out;
}

/** Read every source's latest snapshot and judge each item, as of `now`. */
export async function loadStock(
  accountId: string,
  profileId: string,
  now: Date = new Date(),
): Promise<StockView> {
  const today = now.toISOString().slice(0, 10);
  const rows = await db
    .select({ id: connections.id, provider: connections.provider, purpose: connections.purpose })
    .from(connections)
    .where(
      and(
        eq(connections.account_id, accountId),
        ne(connections.status, "disconnected"),
        or(eq(connections.purpose, "measure"), eq(connections.purpose, "import")),
      ),
    )
    .orderBy(connections.created_at);
  const conns = rows.filter((r) =>
    r.purpose === "import" ? r.provider === STOCK_IMPORT_PROVIDER : isStockProvider(r.provider),
  );

  const owned = await offerInfo(
    profileId,
    conns.filter((c) => c.purpose === "measure").map((c) => c.provider),
  );
  const sources: StockSource[] = [];
  const items: StockItem[] = [];

  for (const c of conns) {
    const label =
      c.purpose === "import"
        ? "Your stock file"
        : isProviderId(c.provider)
          ? getProvider(c.provider).label
          : c.provider;
    const snapshots = await db
      .select({ period_date: metricObservations.period_date })
      .from(metricObservations)
      .where(
        and(
          eq(metricObservations.connection_id, c.id),
          eq(metricObservations.metric_key, "stock.on_hand"),
        ),
      );
    const asOf =
      snapshots
        .map((r) => r.period_date)
        .sort()
        .at(-1) ?? null;
    if (asOf === null) {
      sources.push({ connection_id: c.id, provider: c.provider, label, as_of: null, items: 0 });
      continue;
    }
    const snap = await db
      .select()
      .from(metricObservations)
      .where(
        and(
          eq(metricObservations.connection_id, c.id),
          eq(metricObservations.period_date, asOf),
          inArray(metricObservations.metric_key, [
            "stock.on_hand",
            "stock.value_at_cost",
            "stock.value_at_price",
            "stock.units_sold_window",
            "stock.days_since_sale",
          ]),
        ),
      );

    // A store's measured sales: units per product per day, and the days covered.
    const daily = new Map<string, Map<string, number>>();
    let covered = 0;
    if (c.purpose === "measure") {
      const from = shiftDay(today, -STOCK.history_days);
      const sales = await db
        .select({
          metric_key: metricObservations.metric_key,
          dimensions: metricObservations.dimensions,
          period_date: metricObservations.period_date,
          value_num: metricObservations.value_num,
        })
        .from(metricObservations)
        .where(
          and(
            eq(metricObservations.connection_id, c.id),
            inArray(metricObservations.metric_key, ["units.daily", "orders.daily"]),
            gte(metricObservations.period_date, from),
          ),
        );
      const yesterday = shiftDay(today, -1);
      let first: string | null = null;
      for (const r of sales) {
        if (r.period_date > yesterday) continue;
        if (r.metric_key === "orders.daily") {
          if (first === null || r.period_date < first) first = r.period_date;
          continue;
        }
        const ref = r.dimensions?.["product_ref"];
        if (!ref || r.value_num === null) continue;
        const byDay = daily.get(ref) ?? new Map<string, number>();
        byDay.set(r.period_date, (byDay.get(r.period_date) ?? 0) + Number(r.value_num));
        daily.set(ref, byDay);
      }
      covered =
        first === null
          ? 0
          : Math.round(
              (Date.parse(`${yesterday}T00:00:00Z`) - Date.parse(`${first}T00:00:00Z`)) /
                86_400_000,
            ) + 1;
    }

    const byRef = new Map<string, typeof snap>();
    for (const r of snap) {
      const ref = r.dimensions?.["product_ref"];
      if (!ref) continue;
      byRef.set(ref, [...(byRef.get(ref) ?? []), r]);
    }
    let count = 0;
    for (const [ref, obs] of byRef) {
      const onHandRow = obs.find((o) => o.metric_key === "stock.on_hand");
      if (!onHandRow || onHandRow.value_num === null) continue;
      count++;
      const onHand = Number(onHandRow.value_num);
      const costRow = obs.find((o) => o.metric_key === "stock.value_at_cost");
      const priceRow = obs.find((o) => o.metric_key === "stock.value_at_price");
      const offer = owned.find((o) => o.refs.get(c.provider) === ref) ?? null;
      const currency = priceRow?.currency ?? costRow?.currency ?? offer?.cost?.currency ?? null;
      let valueAtCost = costRow?.value_minor ?? null;
      let basis: StockItem["cost_basis"] = valueAtCost === null ? null : "measured";
      if (
        valueAtCost === null &&
        offer?.cost &&
        (currency === null || offer.cost.currency === currency)
      ) {
        valueAtCost = onHand * offer.cost.amount_minor;
        basis = "stated";
      }
      const windowRow = obs.find((o) => o.metric_key === "stock.units_sold_window");
      const sinceRow = obs.find((o) => o.metric_key === "stock.days_since_sale");
      items.push({
        provider: c.provider,
        connection_id: c.id,
        ref,
        name: onHandRow.dimensions?.["item_name"] ?? offer?.name ?? ref,
        as_of: asOf,
        on_hand: onHand,
        value_at_cost: valueAtCost,
        value_at_price: priceRow?.value_minor ?? null,
        currency,
        cost_basis: basis,
        offer_id: offer?.id ?? null,
        sales:
          c.purpose === "measure"
            ? { kind: "series", covered_days: covered, daily: daily.get(ref) ?? new Map() }
            : {
                kind: "file",
                window_days:
                  windowRow && windowRow.dimensions?.["window_days"]
                    ? Number(windowRow.dimensions["window_days"])
                    : null,
                units_in_window: windowRow?.value_num != null ? Number(windowRow.value_num) : null,
                days_since_sale: sinceRow?.value_num != null ? Number(sinceRow.value_num) : null,
              },
      });
    }
    sources.push({ connection_id: c.id, provider: c.provider, label, as_of: asOf, items: count });
  }

  const judged: RankedItem[] = items.map((item) => ({ item, assessment: assessItem(item, today) }));
  const dead = await readCurrentField<Money>(profileId, DEAD_STOCK_KEY);
  return {
    today,
    sources,
    items: judged,
    slow: rankSlow(judged),
    stated_dead_stock:
      dead?.status === "answered" && dead.value && Number.isSafeInteger(dead.value.amount_minor)
        ? dead.value
        : null,
  };
}
