// Per-person figures — P6-06 (TASKS-PHASE6.md, rule 28 amended). Pure.
//
// Each person's own numbers, from the appointments the owner's booking
// system recorded against them (booking_appointments.staff_ref): what the
// business's 28-day measures are (lib/bookings/measures.ts, specs/bookings.md
// §4), cut by the person on the appointment, with the same window and the
// same minimums. Facts about the work, shown to the owner:
//
//   · every figure carries what it was counted from (part and whole), and
//     the view carries the window and the source (rules 2 and 6);
//   · under a minimum a figure is "too few to say", with the count and the
//     minimum, never a number (MIN_DUE_APPOINTMENTS, MIN_REBOOK_CLIENTS);
//   · utilisation exists only where the owner stated that person's weekly
//     capacity; it is never assumed;
//   · people come back in alphabetical order of their name, whatever their
//     figures: there is no ordering by any figure, no comparison of one
//     person with another, no score and no verdict (lib/people/fence.test.ts).
//
// Booking revenue is the booking system's list price of completed
// appointments, as for the business (not takings: no tips, products or
// discounts). A person's rebooking rate counts a client who came back to
// anyone at the business, so it describes their clients, not a loyalty
// contest between colleagues.

import type { Money } from "../core/money";
import { money } from "../core/money";
import type { AppLocale } from "../i18n/locales";
import { intlTag } from "../i18n/locales";
import {
  BOOKING_WINDOW_DAYS,
  MIN_DUE_APPOINTMENTS,
  MIN_REBOOK_CLIENTS,
  REBOOK_DAYS,
  pct1,
  rebookCount,
  shiftDate,
} from "../bookings/measures";
import type { MeasuredAppointment } from "../bookings/types";

/** A stored appointment with the person the source recorded on it. */
export interface StaffedAppointment extends MeasuredAppointment {
  staff_ref: string | null;
}

/** Why a figure has no number. */
export type NotMeasured =
  "no_capacity" | "no_prices" | "currencies" | "no_completed" | "no_client" | "not_separated";

/**
 * One figure: a value with what it was counted from (part of whole), or
 * too few to say (the count and the minimum), or not measured and why.
 */
export type Figure<T> =
  | { status: "measured"; value: T; part: number; of: number }
  | { status: "too_few"; count: number; min: number }
  | { status: "unmeasured"; why: NotMeasured };

/** What the owner stated about a person's weekly capacity, and when. */
export interface StatedCapacity {
  per_week: number;
  stated_at: string;
}

export interface PersonFigures {
  /** The person as the source recorded them. */
  person: string;
  /** Every appointment in the window with this person on it, whatever happened to it. */
  appointments: number;
  completed: number;
  /** completed + no-shows + late cancellations: the slots still held when the time came. */
  due: number;
  revenue: Figure<Money>;
  no_show_rate: Figure<number>;
  late_cancellation_rate: Figure<number>;
  utilisation: Figure<number>;
  rebooking_rate: Figure<number>;
  capacity: StatedCapacity | null;
}

export interface PeopleFigures {
  /** The window, inclusive: the 28 days ending on the latest measured day. */
  from: string;
  to: string;
  window_days: number;
  /** The rebooking cohort's window, and how long a client had to come back. */
  cohort_from: string;
  cohort_to: string;
  rebook_days: number;
  /** Alphabetical by name — never by a figure. */
  people: PersonFigures[];
  /** Appointments in the window that name nobody (or someone removed): the business's only. */
  unattributed: number;
}

export interface PeopleInput {
  /** Every stored appointment from the source, from the cohort's start onward. */
  appointments: readonly StaffedAppointment[];
  /** The latest measured day. */
  asOf: string;
  /** False for Square, which folds a late cancellation into NO_SHOW. */
  lateSeparated: boolean;
  /** What the owner stated, by the person's name as the source records it. */
  capacities: ReadonlyMap<string, StatedCapacity>;
}

const inWindow = (a: { day: string }, from: string, to: string) => a.day >= from && a.day <= to;

/** Pure: names in the reader's alphabetical order, case and accents aside. */
export function alphabetical(names: Iterable<string>, locale: AppLocale = "en"): string[] {
  const collator = new Intl.Collator(intlTag(locale), { sensitivity: "base", numeric: true });
  return [...new Set(names)].sort((a, b) => collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0));
}

function rate(part: number, due: number): Figure<number> {
  return due < MIN_DUE_APPOINTMENTS
    ? { status: "too_few", count: due, min: MIN_DUE_APPOINTMENTS }
    : { status: "measured", value: pct1(part, due), part, of: due };
}

function revenueOf(own: readonly StaffedAppointment[], completed: number): Figure<Money> {
  if (completed === 0) return { status: "unmeasured", why: "no_completed" };
  const priced = own.filter((a) => a.status === "completed" && a.price_minor !== null);
  if (priced.length === 0) return { status: "unmeasured", why: "no_prices" };
  const currencies = new Set(priced.map((a) => a.currency));
  const [currency] = [...currencies];
  if (currencies.size !== 1 || typeof currency !== "string") {
    return { status: "unmeasured", why: "currencies" };
  }
  const total = priced.reduce((s, a) => s + (a.price_minor ?? 0), 0);
  return { status: "measured", value: money(total, currency), part: priced.length, of: completed };
}

/** Pure: each person's own figures over the 28 days ending on `asOf`. */
export function peopleFigures(input: PeopleInput, locale: AppLocale = "en"): PeopleFigures {
  const { appointments, asOf, lateSeparated, capacities } = input;
  const from = shiftDate(asOf, -(BOOKING_WINDOW_DAYS - 1));
  const window = appointments.filter((a) => inWindow(a, from, asOf));
  const anyClient = appointments.some((a) => a.client_key !== null);

  const names = new Set<string>(capacities.keys());
  let unattributed = 0;
  for (const a of window) {
    if (a.staff_ref === null) unattributed++;
    else names.add(a.staff_ref);
  }

  const cohort = rebookCount([], [], asOf);
  const people = alphabetical(names, locale).map((person): PersonFigures => {
    const own = window.filter((a) => a.staff_ref === person);
    const count = (s: string) => own.filter((a) => a.status === s).length;
    const completed = count("completed");
    const noShows = count("no_show");
    const late = lateSeparated ? count("cancelled_late") : 0;
    const due = completed + noShows + late;

    const capacity = capacities.get(person) ?? null;
    const slots = capacity ? capacity.per_week * (BOOKING_WINDOW_DAYS / 7) : 0;
    const utilisation: Figure<number> =
      capacity && Number.isFinite(capacity.per_week) && capacity.per_week > 0
        ? { status: "measured", value: pct1(completed, slots), part: completed, of: slots }
        : { status: "unmeasured", why: "no_capacity" };

    const back = rebookCount(
      appointments.filter((a) => a.staff_ref === person),
      appointments,
      asOf,
    );
    const rebooking_rate: Figure<number> = !anyClient
      ? { status: "unmeasured", why: "no_client" }
      : back.cohort < MIN_REBOOK_CLIENTS
        ? { status: "too_few", count: back.cohort, min: MIN_REBOOK_CLIENTS }
        : {
            status: "measured",
            value: pct1(back.back, back.cohort),
            part: back.back,
            of: back.cohort,
          };

    return {
      person,
      appointments: own.length,
      completed,
      due,
      revenue: revenueOf(own, completed),
      no_show_rate: rate(noShows, due),
      late_cancellation_rate: lateSeparated
        ? rate(late, due)
        : { status: "unmeasured", why: "not_separated" },
      utilisation,
      rebooking_rate,
      capacity,
    };
  });

  return {
    from,
    to: asOf,
    window_days: BOOKING_WINDOW_DAYS,
    cohort_from: cohort.cohortFrom,
    cohort_to: cohort.cohortTo,
    rebook_days: REBOOK_DAYS,
    people,
    unattributed,
  };
}
