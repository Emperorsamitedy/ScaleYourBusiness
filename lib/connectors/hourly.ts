// Hourly buckets — P2-27, shared by every connector that sees the moment
// of each sale (Stripe's balance transactions, Shopify's orders).
//
// Buckets are UTC hours: an exact instant, so the business's own clock and
// its daylight saving are applied when the series is read (lib/hours),
// and a timezone learned later re-reads correctly without a re-sync.
// Only hours where something happened are emitted; the connector's daily
// rows say the day was covered, so an absent hour reads as zero.

import type { Observation } from "./provider";

/**
 * The UTC instant of a wall-clock hour in a zone ("2026-07-03", 20,
 * "Europe/Budapest" → 18:00Z). Null for an hour that doesn't exist there
 * (the spring-forward gap); the earlier instant for one that happens twice.
 * For sources that report in local time, like GA4's dateHour.
 */
export function utcOfZonedHour(date: string, hour: number, zone: string): Date | null {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  });
  const base = Date.parse(`${date}T${String(hour).padStart(2, "0")}:00:00Z`);
  for (let offset = -14; offset <= 14; offset++) {
    const at = new Date(base - offset * 3_600_000);
    const p = Object.fromEntries(fmt.formatToParts(at).map((x) => [x.type, x.value]));
    if (`${p.year}-${p.month}-${p.day}` === date && Number(p.hour) === hour) return at;
  }
  return null;
}

export class HourlyBuckets {
  /** "YYYY-MM-DD|HH" → currency → net revenue (minor units). */
  private readonly revenue = new Map<string, Map<string, number>>();
  /** "YYYY-MM-DD|HH" → order count. */
  private readonly orders = new Map<string, number>();

  private static key(instantMs: number): string {
    const d = new Date(instantMs);
    return `${d.toISOString().slice(0, 10)}|${String(d.getUTCHours()).padStart(2, "0")}`;
  }

  addRevenue(instantMs: number, currency: string, minor: number): void {
    const key = HourlyBuckets.key(instantMs);
    const byCurrency = this.revenue.get(key) ?? new Map<string, number>();
    byCurrency.set(currency, (byCurrency.get(currency) ?? 0) + minor);
    this.revenue.set(key, byCurrency);
  }

  /** P2-29: sessions, for GA4's per-hour report. */
  private readonly sessions = new Map<string, number>();

  addSessions(instantMs: number, count: number): void {
    const key = HourlyBuckets.key(instantMs);
    this.sessions.set(key, (this.sessions.get(key) ?? 0) + count);
  }

  addOrder(instantMs: number): void {
    const key = HourlyBuckets.key(instantMs);
    this.orders.set(key, (this.orders.get(key) ?? 0) + 1);
  }

  observations(observedAt: string): Observation[] {
    const out: Observation[] = [];
    for (const [key, byCurrency] of [...this.revenue.entries()].sort()) {
      const [day, hour] = key.split("|") as [string, string];
      for (const [currency, value] of [...byCurrency.entries()].sort()) {
        if (value === 0) continue;
        out.push({
          metric_key: "revenue.hourly",
          period_date: day,
          dimensions: { currency, hour_utc: hour },
          value_minor: value,
          observed_at: observedAt,
        });
      }
    }
    for (const [key, count] of [...this.orders.entries()].sort()) {
      const [day, hour] = key.split("|") as [string, string];
      out.push({
        metric_key: "orders.hourly",
        period_date: day,
        dimensions: { hour_utc: hour },
        value_num: count,
        observed_at: observedAt,
      });
    }
    for (const [key, count] of [...this.sessions.entries()].sort()) {
      if (count === 0) continue;
      const [day, hour] = key.split("|") as [string, string];
      out.push({
        metric_key: "sessions.hourly",
        period_date: day,
        dimensions: { hour_utc: hour },
        value_num: count,
        observed_at: observedAt,
      });
    }
    return out;
  }
}
