// Trading-hours analysis — P2-30 (Phase 2 Session F).
//
// For a business customers visit: when, hour by hour and weekday by
// weekday, does the money come in — and does that say the doors open too
// late, or the last hour doesn't pay for itself? Arithmetic on measured
// hourly revenue (P2-27), never a model.
//
// Read in the business's own clock (P2-26's timezone), with a TRADING-DAY
// cutoff: anything before 05:00 local belongs to the evening before, so
// a 20:00–01:00 night is one Friday, not a Friday and a Saturday. Hours
// after midnight are numbered 24, 25… so the curve reads in order.
//
// Two signals, each per weekday, each with pinned thresholds:
//   opening  the first open hour already earns ≥ 60% of the evening's
//            peak hour — demand probably starts before the doors open
//   closing  the last open hour earned less than one open hour costs on
//            ≥ 75% of the measured days — it isn't paying for itself
//
// The honest limit, stated on every result: a closed hour records no
// sales, so these SUGGEST; a trial (P3-41) proves. And connectors only
// see card payments through them — never cash.

import { and, eq, gte, inArray, lte } from "drizzle-orm";
import { db } from "../../db";
import { businessProfiles, connections, metricObservations } from "../../db/schema";
import { readCurrentField } from "../profile/field-store";
import { shiftDay } from "../trust/series";
import type { OpenPeriod, OpeningSchedule, Weekday } from "./schedule";
import { SCHEDULE_KEY, WEEKDAYS, minutesOf } from "./schedule";
import { ensureTimezone } from "./timezone";

export const TRADING = {
  /** The window read, ending yesterday. */
  window_days: 84,
  /** Fewer measured days of a weekday than this: too_early for that weekday. */
  min_days_per_weekday: 4,
  /** Local hour before which a sale belongs to the previous trading day. */
  cutoff_hour: 5,
  /** First open hour at or above this share of the peak hour: opening signal. */
  opening_share: 0.6,
  /** Last hour under the cost of an open hour on at least this share of days: closing signal. */
  closing_day_share: 0.75,
} as const;

export const OPEN_HOUR_COST_KEY = "presence.open_hour_cost";

export interface HourStat {
  /** Trading-day hour: 0–23, then 24 = 00:00 after midnight, 25 = 01:00… */
  hour: number;
  /** Mean revenue in this hour across the weekday's measured days (minor units). */
  mean_minor: number;
}

export interface WeekdayAnalysis {
  weekday: Weekday;
  days_measured: number;
  verdict: "ok" | "too_early" | "closed" | "hours_unknown";
  curve: HourStat[];
  first_hour: number | null;
  last_hour: number | null;
  peak: HourStat | null;
  opening_signal: boolean;
  closing_signal: boolean | null;
  /** Revenue measured in hours the schedule says are closed — the schedule may be out of date. */
  outside_hours_minor: number;
  arithmetic: string[];
}

export type TradingAnalysis =
  | { status: "unmeasured" | "too_early"; reason: string }
  | {
      status: "ok";
      zone: string;
      currency: string;
      from: string;
      to: string;
      weekdays: WeekdayAnalysis[];
      coverage: string;
      limit: string;
    };

const LIMIT =
  "A closed hour records no sales, so this can only suggest what an earlier opening or a later closing would do. A four-week trial is the proof.";

/** Local date, weekday and hour of an instant in a zone. */
export function localParts(
  instant: Date,
  zone: string,
): { date: string; weekday: Weekday; hour: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
      weekday: "short",
    })
      .formatToParts(instant)
      .map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    weekday: (parts.weekday ?? "").slice(0, 3).toLowerCase() as Weekday,
    hour: Number(parts.hour),
  };
}

/** The trading day a local moment belongs to, and its hour on that day's clock. */
export function tradingSlot(local: { date: string; weekday: Weekday; hour: number }): {
  day: string;
  weekday: Weekday;
  hour: number;
} {
  if (local.hour >= TRADING.cutoff_hour)
    return { day: local.date, weekday: local.weekday, hour: local.hour };
  const i = WEEKDAYS.indexOf(local.weekday);
  return {
    day: shiftDay(local.date, -1),
    weekday: WEEKDAYS[(i + 6) % 7] as Weekday,
    hour: local.hour + 24,
  };
}

/** First and last trading-day hour a weekday's periods cover; null when closed. */
export function openSpan(periods: readonly OpenPeriod[]): { first: number; last: number } | null {
  if (periods.length === 0) return null;
  let first = Infinity;
  let last = -Infinity;
  for (const p of periods) {
    const open = minutesOf(p.open);
    let close = minutesOf(p.close);
    if (close <= open) close += 24 * 60;
    first = Math.min(first, Math.floor(open / 60));
    last = Math.max(last, Math.floor((close - 1) / 60));
  }
  return { first, last };
}

export interface DaySales {
  /** Trading day → (trading hour → revenue minor). */
  byDay: Map<string, Map<number, number>>;
  weekdayOf: Map<string, Weekday>;
}

/** Pure: the per-weekday analysis from bucketed sales. Exported for boundary tests. */
export function analyseWeekday(args: {
  weekday: Weekday;
  days: string[];
  sales: DaySales["byDay"];
  periods: OpenPeriod[] | null;
  hourCostMinor: number | null;
  money: (minor: number) => string;
}): WeekdayAnalysis {
  const { weekday, days, sales, periods, hourCostMinor, money } = args;
  const base: WeekdayAnalysis = {
    weekday,
    days_measured: days.length,
    verdict: "ok",
    curve: [],
    first_hour: null,
    last_hour: null,
    peak: null,
    opening_signal: false,
    closing_signal: null,
    outside_hours_minor: 0,
    arithmetic: [],
  };
  if (periods === null)
    return {
      ...base,
      verdict: "hours_unknown",
      arithmetic: ["opening hours for this day aren't known"],
    };
  const span = openSpan(periods);

  const totals = new Map<number, number>();
  for (const day of days) {
    for (const [hour, value] of sales.get(day) ?? [])
      totals.set(hour, (totals.get(hour) ?? 0) + value);
  }
  const hours = [...totals.keys()].sort((a, b) => a - b);
  const curve = hours.map((hour) => ({
    hour,
    mean_minor: Math.round((totals.get(hour) ?? 0) / Math.max(1, days.length)),
  }));
  const inSpan = (h: number) => span !== null && h >= span.first && h <= span.last;
  const outside = hours.filter((h) => !inSpan(h)).reduce((s, h) => s + (totals.get(h) ?? 0), 0);

  if (span === null) {
    return {
      ...base,
      verdict: "closed",
      curve,
      outside_hours_minor: outside,
      arithmetic:
        outside !== 0
          ? [`closed on this day, yet ${money(outside)} was taken across ${days.length} of them`]
          : [],
    };
  }
  if (days.length < TRADING.min_days_per_weekday) {
    return {
      ...base,
      verdict: "too_early",
      curve,
      first_hour: span.first,
      last_hour: span.last,
      arithmetic: [
        `${days.length} measured day(s) — a verdict needs ${TRADING.min_days_per_weekday}`,
      ],
    };
  }

  const open = curve.filter((c) => inSpan(c.hour));
  const peak = open.reduce<HourStat | null>(
    (best, c) => (best === null || c.mean_minor > best.mean_minor ? c : best),
    null,
  );
  const firstMean = curve.find((c) => c.hour === span.first)?.mean_minor ?? 0;
  const arithmetic: string[] = [];
  let opening = false;
  if (peak && peak.mean_minor > 0) {
    const share = firstMean / peak.mean_minor;
    opening = share >= TRADING.opening_share;
    arithmetic.push(
      `first open hour (${label(span.first)}) averages ${money(firstMean)}, ${Math.round(share * 100)}% of the peak hour (${label(peak.hour)}, ${money(peak.mean_minor)}) — the opening signal starts at ${TRADING.opening_share * 100}%`,
    );
  }

  let closing: boolean | null = null;
  if (hourCostMinor !== null) {
    const under = days.filter((d) => (sales.get(d)?.get(span.last) ?? 0) < hourCostMinor).length;
    const share = under / days.length;
    closing = share >= TRADING.closing_day_share;
    arithmetic.push(
      `last open hour (${label(span.last)}) took less than an open hour costs (${money(hourCostMinor)}) on ${under} of ${days.length} days (${Math.round(share * 100)}%) — the closing signal starts at ${TRADING.closing_day_share * 100}%`,
    );
  } else {
    arithmetic.push("the closing check needs the cost of one open hour");
  }
  if (outside !== 0) {
    arithmetic.push(
      `${money(outside)} was taken outside the stated hours — the hours may be out of date`,
    );
  }

  return {
    ...base,
    curve,
    first_hour: span.first,
    last_hour: span.last,
    peak,
    opening_signal: opening,
    closing_signal: closing,
    outside_hours_minor: outside,
    arithmetic,
  };
}

/** "20:00", "01:00 (after midnight)". */
export function label(hour: number): string {
  const h = String(hour % 24).padStart(2, "0");
  return hour >= 24 ? `${h}:00 after midnight` : `${h}:00`;
}

/** The analysis for one profile, from what is measured and stated today. */
export async function tradingAnalysis(
  profileId: string,
  now: Date = new Date(),
  format: (minor: number, currency: string) => string = (m, c) => `${(m / 100).toFixed(2)} ${c}`,
): Promise<TradingAnalysis> {
  const tz = await ensureTimezone(profileId);
  if (tz.zone === null)
    return { status: "unmeasured", reason: `the business's timezone isn't known: ${tz.reason}` };

  const [profile] = await db
    .select({ account_id: businessProfiles.account_id })
    .from(businessProfiles)
    .where(eq(businessProfiles.id, profileId));
  const conns = profile
    ? await db
        .select({ id: connections.id })
        .from(connections)
        .where(eq(connections.account_id, profile.account_id))
    : [];
  if (conns.length === 0)
    return { status: "unmeasured", reason: "no connected source measures sales" };

  const today = now.toISOString().slice(0, 10);
  const to = shiftDay(today, -1);
  const from = shiftDay(today, -TRADING.window_days);
  const ids = conns.map((c) => c.id);
  const rows = await db
    .select({
      metric_key: metricObservations.metric_key,
      provider: metricObservations.provider,
      period_date: metricObservations.period_date,
      dimensions: metricObservations.dimensions,
      value_minor: metricObservations.value_minor,
      currency: metricObservations.currency,
    })
    .from(metricObservations)
    .where(
      and(
        inArray(metricObservations.connection_id, ids),
        inArray(metricObservations.metric_key, ["revenue.hourly", "revenue.daily"]),
        gte(metricObservations.period_date, shiftDay(from, -1)),
        lte(metricObservations.period_date, shiftDay(to, 1)),
      ),
    );

  const covered = new Set<string>();
  const currencies = new Set<string>();
  const providers = new Set<string>();
  const byDay: DaySales["byDay"] = new Map();
  const weekdayOf = new Map<string, Weekday>();
  for (const r of rows) {
    if (r.metric_key === "revenue.daily") {
      if (Object.keys(r.dimensions ?? {}).every((k) => k === "currency"))
        covered.add(r.period_date);
      continue;
    }
    const hourUtc = r.dimensions?.hour_utc;
    if (hourUtc === undefined || r.value_minor === null) continue;
    if (r.currency) currencies.add(r.currency);
    providers.add(r.provider);
    const slot = tradingSlot(localParts(new Date(`${r.period_date}T${hourUtc}:00:00Z`), tz.zone));
    if (slot.day < from || slot.day > to) continue;
    const hours = byDay.get(slot.day) ?? new Map<number, number>();
    hours.set(slot.hour, (hours.get(slot.hour) ?? 0) + r.value_minor);
    byDay.set(slot.day, hours);
    weekdayOf.set(slot.day, slot.weekday);
  }
  if (providers.size === 0) {
    return {
      status: "unmeasured",
      reason: "no hourly sales are measured yet — they arrive with the next sync",
    };
  }
  if (currencies.size !== 1) {
    return {
      status: "unmeasured",
      reason: `sales are in ${[...currencies].join(" and ")} — one currency is needed (rule 1)`,
    };
  }
  const currency = [...currencies][0] as string;

  // A trading day counts as measured when its date was covered by a daily row.
  const measuredDays = new Map<Weekday, string[]>(WEEKDAYS.map((d) => [d, []]));
  for (let day = from; day <= to; day = shiftDay(day, 1)) {
    if (!covered.has(day)) continue;
    const weekday = localParts(new Date(`${day}T12:00:00Z`), tz.zone).weekday;
    measuredDays.get(weekday)?.push(day);
  }

  const scheduleField = await readCurrentField<OpeningSchedule>(profileId, SCHEDULE_KEY);
  const schedule = scheduleField?.value ?? null;
  const costField = await readCurrentField<{ amount_minor: number; currency: string }>(
    profileId,
    OPEN_HOUR_COST_KEY,
  );
  const cost =
    costField?.status === "answered" && costField.value && costField.value.currency === currency
      ? costField.value.amount_minor
      : null;

  const weekdays = WEEKDAYS.map((weekday) =>
    analyseWeekday({
      weekday,
      days: measuredDays.get(weekday) ?? [],
      sales: byDay,
      periods:
        schedule === null || schedule.unstated.includes(weekday) ? null : schedule.days[weekday],
      hourCostMinor: cost,
      money: (m) => format(m, currency),
    }),
  );

  return {
    status: "ok",
    zone: tz.zone,
    currency,
    from,
    to,
    weekdays,
    coverage: `card payments through ${[...providers].sort().join(", ")} only — cash sales aren't seen by any connection`,
    limit: LIMIT,
  };
}
