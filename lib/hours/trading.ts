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
import { SCHEDULE_KEY, WEEKDAYS, openSpan } from "./schedule";
import { competitorLine, competitorOpenings } from "./competitors";
import { coverageLine } from "./coverage";
import { ensureTimezone } from "./timezone";
import { perUnit, ratioBp } from "../core/money";

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
  /** P2-29: share of a weekday's website sessions in the hours just before opening… */
  attention_share: 0.3,
  /** …over this many hours before the first open hour… */
  attention_window_hours: 3,
  /** …counted only above this many sessions on that weekday in the window read. */
  attention_min_sessions: 30,
} as const;

export const OPEN_HOUR_COST_KEY = "presence.open_hour_cost";
/** P3-41: the trials running now, written by lib/hours/trials. */
export const TRIALS_KEY = "presence.hours_trials";

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
  /** P2-29: website attention just before opening; null without enough measured sessions. */
  attention_signal: boolean | null;
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

export { openSpan };

export interface DaySales {
  /** Trading day → (trading hour → revenue minor). */
  byDay: Map<string, Map<number, number>>;
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
    attention_signal: null,
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
    mean_minor: perUnit(totals.get(hour) ?? 0, Math.max(1, days.length)),
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
    // Compared in integers: first × 10 000 against the signal in basis points × peak.
    const openingBp = Math.round(TRADING.opening_share * 10_000);
    opening = firstMean * 10_000 >= openingBp * peak.mean_minor;
    const sharePct = perUnit(ratioBp(firstMean, peak.mean_minor), 100);
    arithmetic.push(
      `first open hour (${label(span.first)}) averages ${money(firstMean)}, ${sharePct}% of the peak hour (${label(peak.hour)}, ${money(peak.mean_minor)}) — the opening signal starts at ${TRADING.opening_share * 100}%`,
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

export interface TradingSales {
  zone: string;
  currency: string;
  providers: string[];
  /** Trading day → trading hour → revenue (minor units). */
  byDay: DaySales["byDay"];
  /** Measured trading days per weekday, oldest first. */
  measuredDays: Map<Weekday, string[]>;
}

/**
 * Measured sales per trading day in the business's clock, for trading
 * days from..to. Shared by the analysis (P2-30) and the trials' verdicts
 * (P3-41). Null-with-reason when it can't be measured honestly.
 */
export async function loadTradingSales(
  profileId: string,
  from: string,
  to: string,
): Promise<TradingSales | { reason: string }> {
  const tz = await ensureTimezone(profileId);
  if (tz.zone === null) return { reason: `the business's timezone isn't known: ${tz.reason}` };

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
  if (conns.length === 0) return { reason: "no connected source measures sales" };

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
  }
  if (providers.size === 0) {
    return { reason: "no hourly sales are measured yet — they arrive with the next sync" };
  }
  if (currencies.size !== 1) {
    return {
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
  return { zone: tz.zone, currency, providers: [...providers].sort(), byDay, measuredDays };
}

/** Website sessions per weekday, per trading hour (P2-29, GA4's sessions.hourly). */
export async function loadTradingSessions(
  profileId: string,
  zone: string,
  from: string,
  to: string,
): Promise<Map<Weekday, Map<number, number>>> {
  const [profile] = await db
    .select({ account_id: businessProfiles.account_id })
    .from(businessProfiles)
    .where(eq(businessProfiles.id, profileId));
  const out = new Map<Weekday, Map<number, number>>();
  if (!profile) return out;
  const conns = await db
    .select({ id: connections.id })
    .from(connections)
    .where(eq(connections.account_id, profile.account_id));
  if (conns.length === 0) return out;
  const rows = await db
    .select({
      period_date: metricObservations.period_date,
      dimensions: metricObservations.dimensions,
      value_num: metricObservations.value_num,
    })
    .from(metricObservations)
    .where(
      and(
        inArray(
          metricObservations.connection_id,
          conns.map((c) => c.id),
        ),
        eq(metricObservations.metric_key, "sessions.hourly"),
        gte(metricObservations.period_date, shiftDay(from, -1)),
        lte(metricObservations.period_date, shiftDay(to, 1)),
      ),
    );
  for (const r of rows) {
    const hourUtc = r.dimensions?.hour_utc;
    if (hourUtc === undefined) continue;
    const slot = tradingSlot(localParts(new Date(`${r.period_date}T${hourUtc}:00:00Z`), zone));
    if (slot.day < from || slot.day > to) continue;
    const hours = out.get(slot.weekday) ?? new Map<number, number>();
    hours.set(slot.hour, (hours.get(slot.hour) ?? 0) + Number(r.value_num ?? 0));
    out.set(slot.weekday, hours);
  }
  return out;
}

/**
 * Pure: the attention signal for one weekday — the share of its website
 * sessions in the hours just before opening. Null without a known first
 * hour or with too few sessions to say anything. Exported for tests.
 */
export function attentionFor(
  w: Pick<WeekdayAnalysis, "first_hour" | "verdict">,
  hours: Map<number, number> | undefined,
): { signal: boolean | null; line: string | null } {
  if (w.verdict !== "ok" || w.first_hour === null || !hours) return { signal: null, line: null };
  let total = 0;
  let before = 0;
  for (const [hour, count] of hours) {
    total += count;
    if (hour >= w.first_hour - TRADING.attention_window_hours && hour < w.first_hour)
      before += count;
  }
  if (total < TRADING.attention_min_sessions) {
    return {
      signal: null,
      line: `${total} website session(s) measured on this day — the attention check needs ${TRADING.attention_min_sessions}`,
    };
  }
  const share = before / total;
  return {
    signal: share >= TRADING.attention_share,
    line: `${Math.round(share * 100)}% of this day's website sessions come in the ${TRADING.attention_window_hours} hours before you open (${label(w.first_hour)}) — the attention signal starts at ${TRADING.attention_share * 100}%`,
  };
}

/** The open-hour cost when it is stated in the sales' currency; null otherwise. */
export async function openHourCost(profileId: string, currency: string): Promise<number | null> {
  const costField = await readCurrentField<{ amount_minor: number; currency: string }>(
    profileId,
    OPEN_HOUR_COST_KEY,
  );
  return costField?.status === "answered" &&
    costField.value &&
    costField.value.currency === currency
    ? costField.value.amount_minor
    : null;
}

/** The analysis for one profile, from what is measured and stated today. */
export async function tradingAnalysis(
  profileId: string,
  now: Date = new Date(),
  format: (minor: number, currency: string) => string = (m, c) => `${(m / 100).toFixed(2)} ${c}`,
): Promise<TradingAnalysis> {
  const today = now.toISOString().slice(0, 10);
  const to = shiftDay(today, -1);
  const from = shiftDay(today, -TRADING.window_days);
  const sales = await loadTradingSales(profileId, from, to);
  if ("reason" in sales) return { status: "unmeasured", reason: sales.reason };
  const { zone, currency, byDay, measuredDays, providers } = sales;

  const scheduleField = await readCurrentField<OpeningSchedule>(profileId, SCHEDULE_KEY);
  const schedule = scheduleField?.value ?? null;
  const cost = await openHourCost(profileId, currency);
  // P3-41: a weekday under a running trial keeps different hours on those
  // days; they are left out so the trial can't feed its own signal.
  const trials =
    (
      await readCurrentField<{ weekday: Weekday; from: string; to: string }[]>(
        profileId,
        TRIALS_KEY,
      )
    )?.value ?? [];

  const openings = await competitorOpenings(profileId);
  const sessions = await loadTradingSessions(profileId, zone, from, to);
  const weekdays = WEEKDAYS.map((weekday) => {
    const all = measuredDays.get(weekday) ?? [];
    const inTrial = (d: string) =>
      trials.some((t) => t.weekday === weekday && d >= t.from && d <= t.to);
    const result = analyseWeekday({
      weekday,
      days: all.filter((d) => !inTrial(d)),
      sales: byDay,
      periods:
        schedule === null || schedule.unstated.includes(weekday) ? null : schedule.days[weekday],
      hourCostMinor: cost,
      money: (m) => format(m, currency),
    });
    const left = all.filter(inTrial).length;
    if (left > 0) result.arithmetic.push(`${left} day(s) under a running trial are left out`);
    // P2-31: the background check — when competitors open, from their own pages.
    // P2-29: when people look the business up online, against when it opens.
    const att = attentionFor(result, sessions.get(weekday));
    result.attention_signal = att.signal;
    if (att.line) result.arithmetic.push(att.line);
    const rivals = competitorLine(openings.get(weekday), result.first_hour);
    if (rivals) result.arithmetic.push(rivals);
    return result;
  });

  return {
    status: "ok",
    zone,
    currency,
    from,
    to,
    weekdays,
    coverage: coverageLine(providers),
    limit: LIMIT,
  };
}
