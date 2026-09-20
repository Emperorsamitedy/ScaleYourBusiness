// The fixture connector — P2-06's "done when": a provider that lives in
// the repo, needs no external account, and behaves like a real one in
// every way that matters to the spine: it validates credentials, reports
// scopes (including, on request, a scope it should not have), backfills a
// year in pages, syncs incrementally from a cursor, and can be made to
// fail so the attempt cap has something to cap.
//
// Every figure is a pure function of the calendar date. No randomness:
// re-ingesting a day yields byte-identical values, which is what lets the
// idempotency test assert exact row counts.

import { isoDate } from "../../core/iso";
import type { Observation, Provider, PullPage } from "../provider";
import { ProviderError } from "../provider";

/** The credential that works. */
export const FIXTURE_SECRET = "fixture-read-only";
/** Valid credential whose provider grants a write scope — must be refused at connect. */
export const FIXTURE_OVERGRANTING_SECRET = "fixture-overgranting";
/** Valid credential whose every pull fails — exercises the failure cap. */
export const FIXTURE_FAILING_SECRET = "fixture-always-fails";

export const FIXTURE_CURRENCY = "EUR";
export const FIXTURE_BACKFILL_DAYS = 365;
export const FIXTURE_PAGE_DAYS = 90;
export const FIXTURE_SCOPES = ["read_revenue", "read_orders", "read_ad_spend"] as const;

const DAY_MS = 86_400_000;

function utcMidnight(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * DAY_MS);
}

function dayString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * The shop's day: a weekday rhythm (Saturday best, Sunday quietest) over
 * a slow upward drift through the year. €48.50 per order, €90/day on ads.
 */
export function fixtureDay(date: string): {
  revenue_minor: number;
  orders: number;
  ad_spend_minor: number;
} {
  const d = new Date(`${isoDate(date)}T00:00:00Z`);
  const weekday = [0.6, 1.0, 1.05, 1.1, 1.1, 1.2, 0.75][d.getUTCDay()] ?? 1;
  const dayIndex = Math.floor(d.getTime() / DAY_MS);
  const drift = 1 + ((dayIndex % 365) / 365) * 0.1;
  const orders = Math.round(12 * weekday * drift);
  return { revenue_minor: orders * 4_850, orders, ad_spend_minor: 9_000 };
}

export function fixtureObservations(date: string, observedAt: string): Observation[] {
  const day = fixtureDay(date);
  return [
    {
      metric_key: "revenue.daily",
      period_date: date,
      dimensions: { currency: FIXTURE_CURRENCY },
      value_minor: day.revenue_minor,
      observed_at: observedAt,
    },
    {
      metric_key: "orders.daily",
      period_date: date,
      dimensions: {},
      value_num: day.orders,
      observed_at: observedAt,
    },
    {
      metric_key: "ad_spend.daily",
      period_date: date,
      dimensions: { currency: FIXTURE_CURRENCY },
      value_minor: day.ad_spend_minor,
      observed_at: observedAt,
    },
  ];
}

export const fixtureProvider: Provider = {
  id: "fixture",
  label: "Fixture",
  scopeVerification: "reported",

  async connect(secret) {
    if (secret === FIXTURE_SECRET || secret === FIXTURE_FAILING_SECRET) {
      return { granted_scopes: [...FIXTURE_SCOPES] };
    }
    if (secret === FIXTURE_OVERGRANTING_SECRET) {
      return { granted_scopes: [...FIXTURE_SCOPES, "write_orders"] };
    }
    throw new ProviderError("fixture: invalid credentials");
  },

  async pull(secret, cursor, now): Promise<PullPage> {
    if (secret === FIXTURE_FAILING_SECRET) {
      throw new ProviderError("fixture: upstream unavailable (deliberate)");
    }
    if (secret !== FIXTURE_SECRET) {
      throw new ProviderError("fixture: invalid credentials");
    }
    // The last complete day is yesterday; today is still being written.
    const yesterday = addDays(utcMidnight(now), -1);
    const start =
      cursor === null
        ? addDays(yesterday, -(FIXTURE_BACKFILL_DAYS - 1))
        : addDays(new Date(`${isoDate(cursor)}T00:00:00Z`), 1);
    if (start.getTime() > yesterday.getTime()) {
      return { observations: [], cursor, done: true };
    }
    const end = new Date(
      Math.min(addDays(start, FIXTURE_PAGE_DAYS - 1).getTime(), yesterday.getTime()),
    );
    const observedAt = now.toISOString();
    const observations: Observation[] = [];
    for (let d = start; d.getTime() <= end.getTime(); d = addDays(d, 1)) {
      observations.push(...fixtureObservations(dayString(d), observedAt));
    }
    return {
      observations,
      cursor: dayString(end),
      done: end.getTime() === yesterday.getTime(),
    };
  },
};
