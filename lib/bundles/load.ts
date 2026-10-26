// Reading what goes together — idea 48. Read-only: the stored order
// baskets and appointments, the owner's offers and their matches; nothing
// is written, no model is called.
//
// Two sources, as data rather than a business-type branch:
//
//   orders   every store connection's order_baskets (Shopify, WooCommerce)
//            of the last BUNDLES.window_days. One store's orders at a time
//            — the one with the most baskets — because two stores' product
//            ids never name the same thing.
//   visits   the account's appointments (a Square read or a bookings
//            export): one client's completed appointments on one day.
//
// An item's name is the owner's offer it is matched to, else the store's
// own title from its latest stock read, else its id. Its economics (for the
// pair's margin) are the matched offer's price and cost from the unit
// economics engine — the owner's own figures — and unknown otherwise.

import { and, eq, gte, inArray, lte, ne, or } from "drizzle-orm";
import { db } from "../../db";
import {
  accounts,
  bookingAppointments,
  businessProfiles,
  connections,
  metricObservations,
  orderBaskets,
} from "../../db/schema";
import { shiftDay } from "../anomaly/baseline";
import { sourceLabel } from "../charts/load";
import { mappingKey } from "../connectors/mapping";
import type { OfferEconomics } from "../economics/unit-economics";
import { computeEconomics } from "../economics/unit-economics";
import { readCurrentField } from "../profile/field-store";
import { ensureSnapshot, readSnapshot } from "../profile/snapshot";
import type { ItemEconomics, PairMargin, PairStat, PairsResult } from "./pairs";
import { BUNDLES, minePairs, pairMargin, visitsOf } from "./pairs";

export interface PairView extends PairStat {
  /** Stable across reads: the proposal is keyed by it. */
  key: string;
  a_name: string;
  b_name: string;
  margin: PairMargin;
  sentence: string;
}

export interface BundleSource {
  kind: "orders" | "visits";
  connection_id: string;
  label: string;
  from: string;
  to: string;
  result: PairsResult;
  pairs: PairView[];
  /** Visits only: completed appointments with no client or service, which can't be grouped. */
  ungrouped: number;
}

export interface BundlesView {
  today: string;
  sources: BundleSource[];
  thresholds: { min_baskets: number; min_together: number; min_lift: number; window_days: number };
  /** Stores connected that can't say what went together (Stripe: payments, not products). */
  without_lines: string[];
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const oneDecimal = (x: number) => (Math.round(x * 10) / 10).toFixed(1);

export function pairSentence(
  p: PairStat,
  aName: string,
  bName: string,
  unit: "orders" | "visits",
): string {
  return `${aName} and ${bName}: together in ${p.together} ${unit} (${pct(p.confidence)} of ${unit} with ${aName}) — ${oneDecimal(p.lift)}× what chance alone would give (about ${Math.round(p.expected)}).`;
}

export function pairKey(connectionId: string, a: string, b: string): string {
  return `${connectionId}:${a < b ? `${a}+${b}` : `${b}+${a}`}`;
}

/** The owner's offers, their economics, and which store product each is matched to. */
async function offerLookup(profileId: string, providers: readonly string[]) {
  const [profile] = await db
    .select({ currency: accounts.reporting_currency })
    .from(businessProfiles)
    .innerJoin(accounts, eq(accounts.id, businessProfiles.account_id))
    .where(eq(businessProfiles.id, profileId));
  const view = await readSnapshot((await ensureSnapshot(profileId)).id);
  const economics = computeEconomics(view, profile?.currency ?? "EUR").offers;
  const byRef = new Map<string, OfferEconomics>(); // `${provider}|${ref}` → offer
  for (const o of economics) {
    for (const p of providers) {
      const m = await readCurrentField<{ product_ref?: unknown }>(
        profileId,
        mappingKey(o.offer_id, p),
      );
      if (m?.status === "answered" && typeof m.value?.product_ref === "string") {
        byRef.set(`${p}|${m.value.product_ref}`, o);
      }
    }
  }
  const byName = new Map<string, OfferEconomics>();
  for (const o of economics) byName.set(o.name.trim().toLowerCase(), o);
  return { byRef, byName };
}

const economicsOf = (o: OfferEconomics | undefined): ItemEconomics | null =>
  o
    ? {
        price_minor: o.price.amount_minor,
        cost_minor:
          o.cost_to_deliver && o.cost_to_deliver.currency === o.price.currency
            ? o.cost_to_deliver.amount_minor
            : null,
        currency: o.price.currency,
      }
    : null;

/** The store's own titles, from the latest stock read that named each product. */
async function storeTitles(connectionId: string): Promise<Map<string, string>> {
  const rows = await db
    .select({
      dimensions: metricObservations.dimensions,
      period_date: metricObservations.period_date,
    })
    .from(metricObservations)
    .where(
      and(
        eq(metricObservations.connection_id, connectionId),
        eq(metricObservations.metric_key, "stock.on_hand"),
      ),
    );
  const out = new Map<string, { name: string; at: string }>();
  for (const r of rows) {
    const ref = r.dimensions?.["product_ref"];
    const name = r.dimensions?.["item_name"];
    if (!ref || !name) continue;
    const cur = out.get(ref);
    if (!cur || r.period_date > cur.at) out.set(ref, { name, at: r.period_date });
  }
  return new Map([...out].map(([ref, v]) => [ref, v.name]));
}

function shortRef(ref: string): string {
  const tail = ref.split("/").at(-1) ?? ref;
  return `Product ${tail}`;
}

export async function loadBundles(
  accountId: string,
  profileId: string,
  now: Date = new Date(),
): Promise<BundlesView> {
  const today = now.toISOString().slice(0, 10);
  const to = shiftDay(today, -1);
  const from = shiftDay(today, -BUNDLES.window_days);
  const view: BundlesView = {
    today,
    sources: [],
    thresholds: {
      min_baskets: BUNDLES.min_baskets,
      min_together: BUNDLES.min_together,
      min_lift: BUNDLES.min_lift,
      window_days: BUNDLES.window_days,
    },
    without_lines: [],
  };

  const conns = await db
    .select({ id: connections.id, provider: connections.provider, purpose: connections.purpose })
    .from(connections)
    .where(
      and(
        eq(connections.account_id, accountId),
        ne(connections.status, "disconnected"),
        or(eq(connections.purpose, "measure"), eq(connections.purpose, "import")),
      ),
    );
  if (conns.length === 0) return view;
  if (conns.some((c) => c.provider === "stripe")) view.without_lines.push("Stripe");
  const lookup = await offerLookup(
    profileId,
    conns.filter((c) => c.purpose === "measure").map((c) => c.provider),
  );

  /* orders: the store with the most baskets */
  const baskets = await db
    .select({
      connection_id: orderBaskets.connection_id,
      product_refs: orderBaskets.product_refs,
    })
    .from(orderBaskets)
    .where(
      and(
        inArray(
          orderBaskets.connection_id,
          conns.map((c) => c.id),
        ),
        gte(orderBaskets.day, from),
        lte(orderBaskets.day, to),
      ),
    );
  const byConn = new Map<string, string[][]>();
  for (const b of baskets) {
    byConn.set(b.connection_id, [...(byConn.get(b.connection_id) ?? []), b.product_refs]);
  }
  const store = [...byConn.entries()].sort((x, y) => y[1].length - x[1].length)[0];
  if (store) {
    const conn = conns.find((c) => c.id === store[0])!;
    const titles = await storeTitles(conn.id);
    const nameOf = (ref: string) =>
      lookup.byRef.get(`${conn.provider}|${ref}`)?.name ?? titles.get(ref) ?? shortRef(ref);
    const result = minePairs(store[1].map((items) => ({ items })));
    view.sources.push({
      kind: "orders",
      connection_id: conn.id,
      label: sourceLabel(conn.provider),
      from,
      to,
      result,
      pairs:
        result.status === "mined"
          ? result.pairs.map((p) => {
              const aName = nameOf(p.a);
              const bName = nameOf(p.b);
              return {
                ...p,
                key: pairKey(conn.id, p.a, p.b),
                a_name: aName,
                b_name: bName,
                margin: pairMargin(
                  {
                    name: aName,
                    economics: economicsOf(lookup.byRef.get(`${conn.provider}|${p.a}`)),
                  },
                  {
                    name: bName,
                    economics: economicsOf(lookup.byRef.get(`${conn.provider}|${p.b}`)),
                  },
                ),
                sentence: pairSentence(p, aName, bName, "orders"),
              };
            })
          : [],
      ungrouped: 0,
    });
  }

  /* visits: one client's completed appointments on one day */
  const appts = await db
    .select({
      connection_id: bookingAppointments.connection_id,
      day: bookingAppointments.day,
      client_key: bookingAppointments.client_key,
      service: bookingAppointments.service,
      status: bookingAppointments.status,
    })
    .from(bookingAppointments)
    .where(
      and(
        inArray(
          bookingAppointments.connection_id,
          conns.map((c) => c.id),
        ),
        gte(bookingAppointments.day, from),
        lte(bookingAppointments.day, to),
      ),
    );
  if (appts.length > 0) {
    // One booking source at a time, like one store: the one with the most appointments.
    const counts = new Map<string, number>();
    for (const a of appts) counts.set(a.connection_id, (counts.get(a.connection_id) ?? 0) + 1);
    const connId = [...counts.entries()].sort((x, y) => y[1] - x[1])[0]![0];
    const conn = conns.find((c) => c.id === connId)!;
    const { visits, ungrouped } = visitsOf(appts.filter((a) => a.connection_id === connId));
    const result = minePairs(visits);
    // A service's economics: an offer of exactly the same name, or none.
    const offerFor = (service: string) => lookup.byName.get(service.trim().toLowerCase());
    view.sources.push({
      kind: "visits",
      connection_id: connId,
      label: sourceLabel(conn.provider),
      from,
      to,
      result,
      pairs:
        result.status === "mined"
          ? result.pairs.map((p) => ({
              ...p,
              key: pairKey(connId, p.a, p.b),
              a_name: p.a,
              b_name: p.b,
              margin: pairMargin(
                { name: p.a, economics: economicsOf(offerFor(p.a)) },
                { name: p.b, economics: economicsOf(offerFor(p.b)) },
              ),
              sentence: pairSentence(p, p.a, p.b, "visits"),
            }))
          : [],
      ungrouped,
    });
  }
  return view;
}
