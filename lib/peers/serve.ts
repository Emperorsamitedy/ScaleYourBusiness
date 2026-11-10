// Serving a peer benchmark — architecture-v2 D7, D13.
//
// v1 serves average order value (monthly revenue ÷ orders a month) for the
// reader's cohort: every OTHER business of the same business type that has
// opted in (lib/peers/consent) and states both figures in the reader's own
// currency — never converted (rule 1). The cohort goes through the
// aggregate (./aggregate), which serves nothing below k = 7 or where one
// business dominates; then the reader is told Eurostat is the reference.

import { and, inArray, isNull } from "drizzle-orm";
import { db } from "../../db";
import { fieldRecords, peerBenchmarkConsents } from "../../db/schema";
import { enumCode } from "../core/enum-value";
import { segmentOf } from "../segments/read";
import type { Money } from "../core/money";
import { isIsoCurrency, money, scaleMinorBy } from "../core/money";
import type { Contribution } from "./aggregate";
import { peerAggregate } from "./aggregate";

const TYPE_KEY = "identity.business_type";
const REVENUE_KEY = "revenue.monthly_revenue";
const ORDERS_KEY = "revenue.order_count_monthly";
const KEYS = [TYPE_KEY, REVENUE_KEY, ORDERS_KEY];

export type PeerServed =
  { shown: true; value: Money; businesses: number } | { shown: false; fallback: "eurostat" };

const NOT_SHOWN: PeerServed = { shown: false, fallback: "eurostat" };

function asMoney(v: unknown): Money | null {
  if (v === null || typeof v !== "object") return null;
  const m = v as { amount_minor?: unknown; currency?: unknown };
  if (typeof m.amount_minor !== "number" || !Number.isSafeInteger(m.amount_minor)) return null;
  if (typeof m.currency !== "string" || !isIsoCurrency(m.currency)) return null;
  return { amount_minor: m.amount_minor, currency: m.currency };
}

function asCount(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
}

/** The current value of each of KEYS, per profile. */
async function currentFacts(
  profileIds: readonly string[],
): Promise<Map<string, Map<string, unknown>>> {
  const out = new Map<string, Map<string, unknown>>();
  if (profileIds.length === 0) return out;
  const rows = await db
    .select({
      profile_id: fieldRecords.profile_id,
      field_key: fieldRecords.field_key,
      value: fieldRecords.value,
    })
    .from(fieldRecords)
    .where(
      and(
        inArray(fieldRecords.profile_id, [...profileIds]),
        inArray(fieldRecords.field_key, KEYS),
        isNull(fieldRecords.superseded_at),
      ),
    );
  for (const r of rows) {
    if (r.value === null) continue;
    const facts = out.get(r.profile_id) ?? new Map<string, unknown>();
    facts.set(r.field_key, r.value);
    out.set(r.profile_id, facts);
  }
  return out;
}

/**
 * Money ÷ an order count that may carry decimals (a stated monthly average):
 * both scaled by the count's written decimals, then one exact division.
 */
function perOrders(revenueMinor: number, orders: number): number {
  const decimals = (String(orders).split(".")[1] ?? "").length;
  const scale = 10 ** decimals;
  return scaleMinorBy(revenueMinor, scale, Math.round(orders * scale)); // not money: the count, made whole
}

/** D13: the cohort's average order value for this business, or nothing at all. */
export async function peerAverageOrderValue(profileId: string): Promise<PeerServed> {
  const own = (await currentFacts([profileId])).get(profileId);
  const type = enumCode(own?.get(TYPE_KEY));
  const ownRevenue = asMoney(own?.get(REVENUE_KEY));
  if (type === null || ownRevenue === null) return NOT_SHOWN;
  // The multi-market spec §C: the segment is a cohort dimension. When the
  // reader's is known, only peers of the same segment count.
  const ownSegment = (await segmentOf(profileId)).segment;

  const consented = await db
    .select({ profile_id: peerBenchmarkConsents.profile_id })
    .from(peerBenchmarkConsents)
    .where(isNull(peerBenchmarkConsents.withdrawn_at));
  const peers = consented.map((c) => c.profile_id).filter((id) => id !== profileId);
  const facts = await currentFacts(peers);

  const rows: Contribution[] = [];
  for (const [peer, f] of facts) {
    if (enumCode(f.get(TYPE_KEY)) !== type) continue;
    if (ownSegment !== null && (await segmentOf(peer)).segment !== ownSegment) continue;
    const revenue = asMoney(f.get(REVENUE_KEY));
    const orders = asCount(f.get(ORDERS_KEY));
    if (revenue === null || orders === null || revenue.currency !== ownRevenue.currency) continue;
    rows.push({
      business: peer,
      numerator: revenue.amount_minor,
      denominator: orders,
      currency: revenue.currency,
    });
  }

  const aggregate = peerAggregate(rows);
  if (!aggregate.shown) return NOT_SHOWN;
  // The ratio of totals, in money: exact, from the cohort's own totals
  // (hard rule 1) — the aggregate's float is for counts and shares only.
  const totalRevenue = rows.reduce((n, r) => n + r.numerator, 0);
  const totalOrders = rows.reduce((n, r) => n + r.denominator, 0);
  return {
    shown: true,
    value: money(perOrders(totalRevenue, totalOrders), ownRevenue.currency),
    businesses: aggregate.businesses,
  };
}
