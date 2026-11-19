// The Diagnosis Grade — the v1 build spec §6.2 (P7-50).
//
// The business-level grade, which decides whether a euro (or forint)
// figure may lead the report:
//
//   A  two independent revenue-side sources, each covering at least 60 days,
//      agreeing within REVENUE_AGREEMENT_BP — measured and cross-checked
//   B  at least one revenue-side connector covering at least 60 days
//   C  revenue-side connector data, but less than 60 days of it
//   D  nothing measured on the revenue side: the owner's numbers only
//
// "The full diagnosis with euro leak figures unlocks when the business
// reaches Diagnosis Grade B or better." Below it, the owner sees ranges,
// grades, and what to connect to turn an estimate into a measured number.
//
// Revenue-side sources are data (REVENUE_SERIES): Stripe, Shopify,
// WooCommerce, Square and NAV Online Számla through revenue.daily, and an
// imported bank statement through its money in, cash.money_in.daily (D52:
// a statement that parses cleanly and has a money-in column).

import { and, eq, inArray, max, min, ne, sql } from "drizzle-orm";
import { db } from "../../db";
import { connections, metricObservations } from "../../db/schema";
import type { Grade } from "../core/grade";
import { ratioBp } from "../core/money";
import { BALANCE_IMPORT_PROVIDER, MONEY_IN_METRIC } from "../balance/source";

export const REVENUE_SOURCES: readonly string[] = [
  "stripe",
  "shopify",
  "woocommerce",
  "square",
  "nav_online_szamla",
];

/** Each revenue-side source and the daily series it is graded on (D52). */
export const REVENUE_SERIES: readonly { provider: string; metric: string }[] = [
  ...REVENUE_SOURCES.map((provider) => ({ provider, metric: "revenue.daily" })),
  { provider: BALANCE_IMPORT_PROVIDER, metric: MONEY_IN_METRIC },
];

export const MIN_COVERAGE_DAYS = 60;
/** Two sources agree when their 60-day totals differ by at most 5 %. */
export const REVENUE_AGREEMENT_BP = 500;

export interface SourceCoverage {
  provider: string;
  connection_id: string;
  days: number;
  /** The last 60 days' revenue, per currency, in minor units. */
  totals: Record<string, number>;
}

export interface DiagnosisGrade {
  grade: Grade;
  /** In plain words: what earned the grade, or what's missing. */
  basis: string;
  /** What to connect next to raise it, most useful first. */
  connect_next: string[];
  sources: SourceCoverage[];
}

const DAY = 86_400_000;

/** Pure: the grade these sources earn. */
export function gradeFromCoverage(
  sources: readonly SourceCoverage[],
): Omit<DiagnosisGrade, "sources"> {
  const covered = sources.filter((s) => s.days >= MIN_COVERAGE_DAYS);
  if (covered.length >= 2) {
    for (let i = 0; i < covered.length; i++) {
      for (let j = i + 1; j < covered.length; j++) {
        const a = covered[i]!;
        const b = covered[j]!;
        if (a.provider === b.provider) continue;
        for (const currency of Object.keys(a.totals)) {
          const x = a.totals[currency] ?? 0;
          const y = b.totals[currency];
          if (y === undefined || x <= 0 || y <= 0) continue;
          const bigger = Math.max(x, y);
          if (ratioBp(Math.abs(x - y), bigger) <= REVENUE_AGREEMENT_BP) {
            return {
              grade: "A",
              basis: `${a.provider} and ${b.provider} each cover ${MIN_COVERAGE_DAYS}+ days and agree`,
              connect_next: [],
            };
          }
        }
      }
    }
  }
  if (covered.length >= 1) {
    const missing = REVENUE_SOURCES.filter((p) => !sources.some((s) => s.provider === p));
    return {
      grade: "B",
      basis: `${covered[0]!.provider} covers ${MIN_COVERAGE_DAYS}+ days of revenue`,
      connect_next: missing.slice(0, 2),
    };
  }
  if (sources.length > 0) {
    const longest = sources.reduce((a, b) => (b.days > a.days ? b : a));
    return {
      grade: "C",
      basis: `${longest.provider} has ${longest.days} of the ${MIN_COVERAGE_DAYS} days needed`,
      connect_next: [],
    };
  }
  return {
    grade: "D",
    basis: "no revenue is measured yet: the figures rest on what you told me",
    connect_next: ["stripe", "shopify", "square", "nav_online_szamla"],
  };
}

/** The business's grade from its live revenue-side connections. */
export async function diagnosisGrade(accountId: string, now = new Date()): Promise<DiagnosisGrade> {
  const conns = await db
    .select({ id: connections.id, provider: connections.provider })
    .from(connections)
    .where(
      and(
        eq(connections.account_id, accountId),
        eq(connections.status, "connected"),
        ne(connections.purpose, "execute"),
        inArray(
          connections.provider,
          REVENUE_SERIES.map((s) => s.provider),
        ),
      ),
    );
  const since = new Date(now.getTime() - MIN_COVERAGE_DAYS * DAY).toISOString().slice(0, 10);
  const sources: SourceCoverage[] = [];
  for (const c of conns) {
    const metric = REVENUE_SERIES.find((s) => s.provider === c.provider)!.metric;
    const [span] = await db
      .select({
        first: min(metricObservations.period_date),
        last: max(metricObservations.period_date),
      })
      .from(metricObservations)
      .where(
        and(eq(metricObservations.connection_id, c.id), eq(metricObservations.metric_key, metric)),
      );
    if (!span?.first || !span.last) continue;
    const days = Math.round((Date.parse(span.last) - Date.parse(span.first)) / DAY) + 1;
    const rows = await db
      .select({
        currency: metricObservations.currency,
        total: sql<string>`coalesce(sum(${metricObservations.value_minor}), 0)::text`,
      })
      .from(metricObservations)
      .where(
        and(
          eq(metricObservations.connection_id, c.id),
          eq(metricObservations.metric_key, metric),
          sql`${metricObservations.period_date} >= ${since}`,
        ),
      )
      .groupBy(metricObservations.currency);
    const totals: Record<string, number> = {};
    for (const r of rows) if (r.currency) totals[r.currency] = Number(r.total);
    sources.push({ provider: c.provider, connection_id: c.id, days, totals });
  }
  return { ...gradeFromCoverage(sources), sources };
}

/** §6.2's gate: may a money figure lead (the headline position)? */
export function headlineMoneyAllowed(grade: Grade): boolean {
  return grade === "A" || grade === "B";
}
