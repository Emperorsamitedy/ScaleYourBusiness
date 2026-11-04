// The measures a booking business is judged on — specs/bookings.md §4.
// Deterministic arithmetic on stored appointments; no model, no database.
// Every threshold is a named constant pinned by a boundary test
// (measures.test.ts), and a measure that can't be computed honestly says
// why instead of becoming a number.
//
// L-4c: the arithmetic and the reasons come from the "connectionsWords"
// catalogue (lib/bookings/words.ts). English by default — what a fact
// stores is what the code always said — and the reader's language when the
// Connections screen asks.

import type { Money } from "../core/money";
import { money } from "../core/money";
import type { Observation } from "../connectors/provider";
import type { MeasuredAppointment } from "./types";
import type { Say } from "./words";
import { andList, dayWords, englishSay, plain } from "./words";

/** Four whole weeks, so every weekday counts four times. */
export const BOOKING_WINDOW_DAYS = 28;
/** A client "booked again" if another booking starts within this many days of a completed one. */
export const REBOOK_DAYS = 42;
/** Fewer due appointments than this in the window and a rate is noise, not a measure. */
export const MIN_DUE_APPOINTMENTS = 20;
/** Fewer cohort clients than this and the rebooking rate is not called. */
export const MIN_REBOOK_CLIENTS = 10;

const DAY_MS = 86_400_000;

export function shiftDate(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

const pct1 = (part: number, whole: number): number => Math.round((part / whole) * 1000) / 10;

export type Measure<T> =
  { status: "measured"; value: T; arithmetic: string } | { status: "unmeasured"; reason: string };

export interface BookingMeasures {
  /** The window, inclusive. */
  from: string;
  to: string;
  completed: number;
  no_shows: number;
  /** Null when the source does not separate late cancellations (Square). */
  late_cancellations: number | null;
  cancellations: number;
  /** completed + no-shows + late cancellations: the slots still held when the time came. */
  due: number;
  no_show_rate: Measure<number>;
  late_cancellation_rate: Measure<number>;
  rebooking_rate: Measure<number>;
  revenue: Measure<Money>;
  utilisation: Measure<number>;
}

export interface MeasureOptions {
  /** False for Square: its NO_SHOW covers late cancellations, so they are not separated. */
  lateSeparated: boolean;
  /** The owner's stated appointments a week (service.capacity_per_week), or null. */
  capacityPerWeek: number | null;
  /** Owner-facing name of the source, for the reasons ("Square", "your bookings export"). */
  sourceName: string;
  /** Which source it is, so another language names it in its own words; English uses sourceName. */
  sourceKind?: "square" | "import";
}

/** The source as the reasons name it, in the reader's language. */
function sourceWords(options: MeasureOptions, say: Say): string {
  if (say.locale === "en" || options.sourceKind === undefined) return options.sourceName;
  return say.tr(`bookings.source.${options.sourceKind}`);
}

const inWindow = (a: { day: string }, from: string, to: string) => a.day >= from && a.day <= to;

/** A booking that counts as "booked again": kept, or still held when its time came. */
const HELD = new Set(["completed", "no_show", "cancelled_late", "booked_future"]);

function rebooking(
  appointments: readonly MeasuredAppointment[],
  asOf: string,
  source: string,
  say: Say,
): Measure<number> {
  const { tr, locale } = say;
  if (!appointments.some((a) => a.client_key !== null)) {
    return { status: "unmeasured", reason: tr("bookings.rebook.noClient", { source }) };
  }
  // The cohort ends REBOOK_DAYS before the latest day, so every client in it
  // had the full REBOOK_DAYS to come back by the time the data ends.
  const cohortTo = shiftDate(asOf, -REBOOK_DAYS);
  const cohortFrom = shiftDate(cohortTo, -(BOOKING_WINDOW_DAYS - 1));
  const visits = new Map<string, string[]>();
  const later = new Map<string, string[]>();
  for (const a of appointments) {
    if (a.client_key === null) continue;
    if (a.status === "completed" && inWindow(a, cohortFrom, cohortTo)) {
      visits.set(a.client_key, [...(visits.get(a.client_key) ?? []), a.day]);
    }
    if (HELD.has(a.status)) later.set(a.client_key, [...(later.get(a.client_key) ?? []), a.day]);
  }
  const cohort = visits.size;
  const between = { from: dayWords(cohortFrom, locale), to: dayWords(cohortTo, locale) };
  if (cohort < MIN_REBOOK_CLIENTS) {
    return {
      status: "unmeasured",
      reason: tr("bookings.rebook.few", {
        cohort,
        n: plain(cohort, locale),
        ...between,
        min: plain(MIN_REBOOK_CLIENTS, locale),
        days: plain(REBOOK_DAYS, locale),
      }),
    };
  }
  let back = 0;
  for (const [client, days] of visits) {
    const next = later.get(client) ?? [];
    const returned = days.some((d) =>
      next.some((n) => {
        const gap = daysBetween(d, n);
        return gap >= 1 && gap <= REBOOK_DAYS;
      }),
    );
    if (returned) back++;
  }
  return {
    status: "measured",
    value: pct1(back, cohort),
    arithmetic: tr("bookings.rebook.arithmetic", {
      back: plain(back, locale),
      cohort,
      n: plain(cohort, locale),
      ...between,
      days: plain(REBOOK_DAYS, locale),
    }),
  };
}

/** The 28-day measures ending on `asOf`, the latest measured day. */
export function bookingMeasures(
  appointments: readonly MeasuredAppointment[],
  asOf: string,
  options: MeasureOptions,
  say: Say = englishSay(),
): BookingMeasures {
  const { tr, locale } = say;
  const source = sourceWords(options, say);
  const n = (x: number) => plain(x, locale);
  const from = shiftDate(asOf, -(BOOKING_WINDOW_DAYS - 1));
  const win = appointments.filter((a) => inWindow(a, from, asOf));
  const count = (s: string) => win.filter((a) => a.status === s).length;
  const completed = count("completed");
  const noShows = count("no_show");
  const late = options.lateSeparated ? count("cancelled_late") : null;
  const due = completed + noShows + (late ?? 0);
  const window = { from: dayWords(from, locale), to: dayWords(asOf, locale) };
  const period = tr("bookings.period", window);
  const breakdown =
    late === null
      ? tr("bookings.breakdown", { completed: n(completed), noShows: n(noShows) })
      : tr("bookings.breakdownLate", {
          completed: n(completed),
          noShows: n(noShows),
          late: n(late),
        });

  const rate = (part: number, which: "noShow" | "late"): Measure<number> =>
    due < MIN_DUE_APPOINTMENTS
      ? {
          status: "unmeasured",
          reason: tr("bookings.rate.few", {
            due,
            n: n(due),
            ...window,
            min: n(MIN_DUE_APPOINTMENTS),
          }),
        }
      : {
          status: "measured",
          value: pct1(part, due),
          arithmetic: tr(`bookings.rate.${which}`, {
            part: n(part),
            due,
            n: n(due),
            breakdown,
            period,
          }),
        };

  // Revenue: completed appointments' prices, one currency or none.
  let revenue: Measure<Money>;
  const priced = win.filter((a) => a.status === "completed" && a.price_minor !== null);
  const currencies = [...new Set(priced.map((a) => a.currency ?? "?"))].sort();
  if (completed === 0) {
    revenue = { status: "unmeasured", reason: tr("bookings.revenue.none", { period }) };
  } else if (priced.length === 0) {
    revenue = { status: "unmeasured", reason: tr("bookings.revenue.noPrices", { source }) };
  } else if (currencies.length !== 1 || currencies[0] === "?") {
    revenue = {
      status: "unmeasured",
      reason: tr("bookings.revenue.currencies", { list: andList(currencies, locale) }),
    };
  } else {
    const total = priced.reduce((s, a) => s + (a.price_minor ?? 0), 0);
    const unpriced = completed - priced.length;
    revenue = {
      status: "measured",
      value: money(total, currencies[0] as string),
      arithmetic: tr(unpriced > 0 ? "bookings.revenue.sumUnpriced" : "bookings.revenue.sum", {
        count: priced.length,
        n: n(priced.length),
        period,
        unpriced: n(unpriced),
      }),
    };
  }

  const cap = options.capacityPerWeek;
  const utilisation: Measure<number> =
    cap === null || !Number.isFinite(cap) || cap <= 0
      ? { status: "unmeasured", reason: tr("bookings.utilisation.none") }
      : {
          status: "measured",
          value: pct1(completed, cap * (BOOKING_WINDOW_DAYS / 7)),
          arithmetic: tr("bookings.utilisation.arithmetic", {
            completed: n(completed),
            cap: n(cap),
            weeks: n(BOOKING_WINDOW_DAYS / 7),
            slots: n(cap * (BOOKING_WINDOW_DAYS / 7)),
            period,
          }),
        };

  return {
    from,
    to: asOf,
    completed,
    no_shows: noShows,
    late_cancellations: late,
    cancellations: count("cancelled"),
    due,
    no_show_rate: rate(noShows, "noShow"),
    late_cancellation_rate:
      late === null
        ? { status: "unmeasured", reason: tr("bookings.lateNotSeparated", { source }) }
        : rate(late, "late"),
    rebooking_rate: rebooking(appointments, asOf, source, say),
    revenue,
    utilisation,
  };
}

/**
 * Daily observations for every day in [from, to], zeros included, from the
 * appointments counted on those days. Booking revenue goes out only when
 * the source has prices, per currency seen in the range (rule 1).
 */
export function dailyBookingObservations(
  appointments: readonly Omit<MeasuredAppointment, "client_key">[],
  from: string,
  to: string,
  observedAt: string,
  options: { lateSeparated: boolean },
): Observation[] {
  if (from > to) return [];
  const counts = new Map<string, { c: number; n: number; l: number; x: number }>();
  const revenue = new Map<string, Map<string, number>>();
  const currencies = new Set<string>();
  for (const a of appointments) {
    if (!inWindow(a, from, to)) continue;
    const day = counts.get(a.day) ?? { c: 0, n: 0, l: 0, x: 0 };
    if (a.status === "completed") day.c++;
    else if (a.status === "no_show") day.n++;
    else if (a.status === "cancelled_late") day.l++;
    else if (a.status === "cancelled") day.x++;
    counts.set(a.day, day);
    if (a.status === "completed" && a.price_minor !== null && a.currency !== null) {
      currencies.add(a.currency);
      const byCurrency = revenue.get(a.day) ?? new Map<string, number>();
      byCurrency.set(a.currency, (byCurrency.get(a.currency) ?? 0) + a.price_minor);
      revenue.set(a.day, byCurrency);
    }
  }
  const out: Observation[] = [];
  const sorted = [...currencies].sort();
  for (let day = from; day <= to; day = shiftDate(day, 1)) {
    const c = counts.get(day) ?? { c: 0, n: 0, l: 0, x: 0 };
    const count = (metric_key: Observation["metric_key"], value_num: number) =>
      out.push({
        metric_key,
        period_date: day,
        dimensions: {},
        value_num,
        observed_at: observedAt,
      });
    count("appointments_completed.daily", c.c);
    count("appointments_no_show.daily", c.n);
    if (options.lateSeparated) count("appointments_cancelled_late.daily", c.l);
    count("appointments_cancelled.daily", c.x);
    for (const currency of sorted) {
      out.push({
        metric_key: "booking_revenue.daily",
        period_date: day,
        dimensions: { currency },
        value_minor: revenue.get(day)?.get(currency) ?? 0,
        observed_at: observedAt,
      });
    }
  }
  return out;
}
