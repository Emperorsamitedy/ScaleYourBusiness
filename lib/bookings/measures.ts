// The measures a booking business is judged on — specs/bookings.md §4.
// Deterministic arithmetic on stored appointments; no model, no database.
// Every threshold is a named constant pinned by a boundary test
// (measures.test.ts), and a measure that can't be computed honestly says
// why instead of becoming a number.

import type { Money } from "../core/money";
import { money } from "../core/money";
import type { Observation } from "../connectors/provider";
import type { MeasuredAppointment } from "./types";

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
}

const inWindow = (a: { day: string }, from: string, to: string) => a.day >= from && a.day <= to;

/** A booking that counts as "booked again": kept, or still held when its time came. */
const HELD = new Set(["completed", "no_show", "cancelled_late", "booked_future"]);

function rebooking(
  appointments: readonly MeasuredAppointment[],
  asOf: string,
  sourceName: string,
): Measure<number> {
  if (!appointments.some((a) => a.client_key !== null)) {
    return {
      status: "unmeasured",
      reason: `${sourceName} has no client id, email or phone I can follow, so I can't see who came back`,
    };
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
  if (cohort < MIN_REBOOK_CLIENTS) {
    return {
      status: "unmeasured",
      reason:
        `${cohort} client${cohort === 1 ? "" : "s"} had a completed appointment between ${cohortFrom} and ${cohortTo}; ` +
        `I need at least ${MIN_REBOOK_CLIENTS}, each with ${REBOOK_DAYS} days after it, to call a rebooking rate`,
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
    arithmetic:
      `${back} of ${cohort} clients with a completed appointment between ${cohortFrom} and ${cohortTo} ` +
      `booked again within ${REBOOK_DAYS} days`,
  };
}

/** The 28-day measures ending on `asOf`, the latest measured day. */
export function bookingMeasures(
  appointments: readonly MeasuredAppointment[],
  asOf: string,
  options: MeasureOptions,
): BookingMeasures {
  const from = shiftDate(asOf, -(BOOKING_WINDOW_DAYS - 1));
  const win = appointments.filter((a) => inWindow(a, from, asOf));
  const count = (s: string) => win.filter((a) => a.status === s).length;
  const completed = count("completed");
  const noShows = count("no_show");
  const late = options.lateSeparated ? count("cancelled_late") : null;
  const due = completed + noShows + (late ?? 0);
  const period = `${from} to ${asOf}`;

  const rate = (part: number, noun: string): Measure<number> =>
    due < MIN_DUE_APPOINTMENTS
      ? {
          status: "unmeasured",
          reason: `${due} due appointment${due === 1 ? "" : "s"} between ${from} and ${asOf}; I need at least ${MIN_DUE_APPOINTMENTS} to call a rate`,
        }
      : {
          status: "measured",
          value: pct1(part, due),
          arithmetic: `${part} ${noun} of ${due} due appointments (completed ${completed} + no-shows ${noShows}${late === null ? "" : ` + late cancellations ${late}`}), ${period}`,
        };

  // Revenue: completed appointments' prices, one currency or none.
  let revenue: Measure<Money>;
  const priced = win.filter((a) => a.status === "completed" && a.price_minor !== null);
  const currencies = [...new Set(priced.map((a) => a.currency ?? "?"))].sort();
  if (completed === 0) {
    revenue = { status: "unmeasured", reason: `no completed appointments ${period}` };
  } else if (priced.length === 0) {
    revenue = {
      status: "unmeasured",
      reason: `${options.sourceName} has no prices for these appointments`,
    };
  } else if (currencies.length !== 1 || currencies[0] === "?") {
    revenue = {
      status: "unmeasured",
      reason: `the prices are in ${currencies.join(" and ")}, and currencies never blend`,
    };
  } else {
    const total = priced.reduce((s, a) => s + (a.price_minor ?? 0), 0);
    const unpriced = completed - priced.length;
    revenue = {
      status: "measured",
      value: money(total, currencies[0] as string),
      arithmetic:
        `the listed price of ${priced.length} completed appointment${priced.length === 1 ? "" : "s"}, ${period}` +
        (unpriced > 0 ? ` (${unpriced} had no price and count as nothing)` : ""),
    };
  }

  const cap = options.capacityPerWeek;
  const utilisation: Measure<number> =
    cap === null || !Number.isFinite(cap) || cap <= 0
      ? {
          status: "unmeasured",
          reason:
            "you haven't told me how many appointments you can take a week, so I can't say how full you are — I won't assume a capacity",
        }
      : {
          status: "measured",
          value: pct1(completed, cap * (BOOKING_WINDOW_DAYS / 7)),
          arithmetic: `${completed} completed of a stated ${cap} a week × ${BOOKING_WINDOW_DAYS / 7} weeks = ${cap * (BOOKING_WINDOW_DAYS / 7)} slots, ${period}`,
        };

  return {
    from,
    to: asOf,
    completed,
    no_shows: noShows,
    late_cancellations: late,
    cancellations: count("cancelled"),
    due,
    no_show_rate: rate(noShows, "no-shows"),
    late_cancellation_rate:
      late === null
        ? {
            status: "unmeasured",
            reason: `${options.sourceName} doesn't separate late cancellations: it counts them as no-shows when you mark them`,
          }
        : rate(late, "late cancellations"),
    rebooking_rate: rebooking(appointments, asOf, options.sourceName),
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
