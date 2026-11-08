// P6-06 (rule 28 amended): each person's own figures, pure. Every rule
// here has its passing and its failing case: the bookings minimums at their
// boundaries both ways, utilisation only against a stated capacity, the
// window and counts on every figure, Square's unseparated late
// cancellations, and alphabetical order whatever the figures say.

import { describe, expect, it } from "vitest";
import {
  BOOKING_WINDOW_DAYS,
  MIN_DUE_APPOINTMENTS,
  MIN_REBOOK_CLIENTS,
  REBOOK_DAYS,
  bookingMeasures,
  shiftDate,
} from "../bookings/measures";
import type { BookingStatus } from "../bookings/types";
import type { StaffedAppointment, StatedCapacity } from "./figures";
import { alphabetical, peopleFigures } from "./figures";

const AS_OF = "2026-11-07";
const FROM = shiftDate(AS_OF, -(BOOKING_WINDOW_DAYS - 1));

function appt(
  staff: string | null,
  status: BookingStatus,
  extra: Partial<StaffedAppointment> = {},
): StaffedAppointment {
  return {
    day: AS_OF,
    status,
    client_key: null,
    price_minor: null,
    currency: null,
    staff_ref: staff,
    ...extra,
  };
}

const many = (n: number, make: (i: number) => StaffedAppointment) =>
  Array.from({ length: n }, (_, i) => make(i));

const run = (
  appointments: StaffedAppointment[],
  capacities: Map<string, StatedCapacity> = new Map(),
  lateSeparated = true,
) => peopleFigures({ appointments, asOf: AS_OF, lateSeparated, capacities });

const person = (r: ReturnType<typeof run>, name: string) => {
  const p = r.people.find((x) => x.person === name);
  if (!p) throw new Error(`no ${name}`);
  return p;
};

describe("the window, the source counts and the minimums", () => {
  it("states the 28-day window and counts only appointments inside it", () => {
    const r = run([
      appt("Aoife", "completed", { day: FROM }),
      appt("Aoife", "completed", { day: AS_OF }),
      appt("Aoife", "completed", { day: shiftDate(FROM, -1) }),
    ]);
    expect([r.from, r.to, r.window_days]).toEqual([FROM, AS_OF, 28]);
    expect(person(r, "Aoife").completed).toBe(2);
    expect(person(r, "Aoife").appointments).toBe(2);
  });

  it("calls a rate at exactly the bookings minimum of due appointments, with its part and whole", () => {
    const due = MIN_DUE_APPOINTMENTS;
    const r = run([
      ...many(due - 3, () => appt("Aoife", "completed")),
      appt("Aoife", "no_show"),
      appt("Aoife", "no_show"),
      appt("Aoife", "cancelled_late"),
      appt("Aoife", "cancelled"),
    ]);
    const p = person(r, "Aoife");
    expect(p.due).toBe(due);
    expect(p.no_show_rate).toEqual({ status: "measured", value: 10, part: 2, of: due });
    expect(p.late_cancellation_rate).toEqual({ status: "measured", value: 5, part: 1, of: due });
  });

  it("says too few to say, with the count and the minimum, one under it", () => {
    const r = run([
      ...many(MIN_DUE_APPOINTMENTS - 2, () => appt("Aoife", "completed")),
      appt("Aoife", "no_show"),
    ]);
    const p = person(r, "Aoife");
    expect(p.no_show_rate).toEqual({
      status: "too_few",
      count: MIN_DUE_APPOINTMENTS - 1,
      min: MIN_DUE_APPOINTMENTS,
    });
    expect(p.late_cancellation_rate.status).toBe("too_few");
  });

  it("never separates Square's late cancellations, measured or not", () => {
    const r = run(
      many(30, () => appt("TM1", "completed")),
      new Map(),
      false,
    );
    expect(person(r, "TM1").late_cancellation_rate).toEqual({
      status: "unmeasured",
      why: "not_separated",
    });
    expect(person(r, "TM1").no_show_rate.status).toBe("measured");
  });

  it("counts the appointments that name nobody apart, for the business's figures only", () => {
    const r = run([appt(null, "completed"), appt(null, "no_show"), appt("Aoife", "completed")]);
    expect(r.unattributed).toBe(2);
    expect(r.people.map((p) => p.person)).toEqual(["Aoife"]);
  });
});

describe("booking revenue, in Money (rule 1)", () => {
  it("sums one currency's list prices of completed appointments, with how many were priced", () => {
    const r = run([
      appt("Aoife", "completed", { price_minor: 4500, currency: "EUR" }),
      appt("Aoife", "completed", { price_minor: 3000, currency: "EUR" }),
      appt("Aoife", "completed"),
      appt("Aoife", "no_show", { price_minor: 9900, currency: "EUR" }),
    ]);
    expect(person(r, "Aoife").revenue).toEqual({
      status: "measured",
      value: { amount_minor: 7500, currency: "EUR" },
      part: 2,
      of: 3,
    });
  });

  it("refuses two currencies rather than add them, and says when there are no prices", () => {
    const two = run([
      appt("Aoife", "completed", { price_minor: 4500, currency: "EUR" }),
      appt("Aoife", "completed", { price_minor: 3000, currency: "HUF" }),
    ]);
    expect(person(two, "Aoife").revenue).toEqual({ status: "unmeasured", why: "currencies" });
    const none = run([appt("Aoife", "completed")]);
    expect(person(none, "Aoife").revenue).toEqual({ status: "unmeasured", why: "no_prices" });
    const idle = run([appt("Aoife", "no_show")]);
    expect(person(idle, "Aoife").revenue).toEqual({ status: "unmeasured", why: "no_completed" });
  });
});

describe("utilisation, only against the capacity the owner stated for that person", () => {
  const stated = { per_week: 25, stated_at: "2026-11-01T10:00:00.000Z" };

  it("is completed ÷ (stated a week × 4) when stated", () => {
    const r = run(
      many(80, () => appt("Aoife", "completed")),
      new Map([["Aoife", stated]]),
    );
    expect(person(r, "Aoife").utilisation).toEqual({
      status: "measured",
      value: 80,
      part: 80,
      of: 100,
    });
    expect(person(r, "Aoife").capacity).toEqual(stated);
  });

  it("is not measured without it — never assumed, and never borrowed from a colleague", () => {
    const r = run(
      [appt("Aoife", "completed"), appt("Marta", "completed")],
      new Map([["Aoife", stated]]),
    );
    expect(person(r, "Marta").utilisation).toEqual({ status: "unmeasured", why: "no_capacity" });
    expect(person(r, "Marta").capacity).toBeNull();
  });

  it("lists a person with a stated capacity even in a window with none of their appointments", () => {
    const r = run([], new Map([["Sinead", stated]]));
    expect(person(r, "Sinead").utilisation).toEqual({
      status: "measured",
      value: 0,
      part: 0,
      of: 100,
    });
  });
});

describe("rebooking, of the clients a person saw, back with anyone", () => {
  const cohortDay = shiftDate(AS_OF, -REBOOK_DAYS - 3);
  const backDay = shiftDate(cohortDay, 20);

  /** n clients of `staff` in the cohort window (and `staff` on today's book, so they are listed). */
  function clients(n: number, staff: string, cameBackTo: string | null) {
    return [
      appt(staff, "completed"),
      ...many(n, (i) => appt(staff, "completed", { day: cohortDay, client_key: `c${staff}${i}` })),
    ].concat(
      cameBackTo === null
        ? []
        : many(n, (i) =>
            appt(cameBackTo, "completed", { day: backDay, client_key: `c${staff}${i}` }),
          ),
    );
  }

  it("counts a client who came back to a colleague, and names the cohort window", () => {
    const r = run(clients(MIN_REBOOK_CLIENTS, "Aoife", "Marta"));
    expect(person(r, "Aoife").rebooking_rate).toEqual({
      status: "measured",
      value: 100,
      part: MIN_REBOOK_CLIENTS,
      of: MIN_REBOOK_CLIENTS,
    });
    expect(r.cohort_to).toBe(shiftDate(AS_OF, -REBOOK_DAYS));
    expect(r.rebook_days).toBe(REBOOK_DAYS);
  });

  it("is too few to say one client under the minimum", () => {
    const r = run(clients(MIN_REBOOK_CLIENTS - 1, "Aoife", null));
    expect(person(r, "Aoife").rebooking_rate).toEqual({
      status: "too_few",
      count: MIN_REBOOK_CLIENTS - 1,
      min: MIN_REBOOK_CLIENTS,
    });
  });

  it("is not measured when the source has no client identity at all", () => {
    const r = run(many(30, () => appt("Aoife", "completed")));
    expect(person(r, "Aoife").rebooking_rate).toEqual({ status: "unmeasured", why: "no_client" });
  });
});

describe("rule 28 amended: listed by name, never by a figure", () => {
  const busy = many(40, () => appt("Zoë", "completed"));
  const quiet = [appt("aoife", "completed"), appt("Marta", "no_show")];

  it("lists people alphabetically whatever their figures", () => {
    const r = run([...busy, ...quiet]);
    expect(r.people.map((p) => p.person)).toEqual(["aoife", "Marta", "Zoë"]);
  });

  it("gives the same list for the same appointments in any order", () => {
    const a = run([...busy, ...quiet]);
    const b = run([...quiet].reverse().concat(busy));
    expect(b).toEqual(a);
  });

  it("would fail if the list followed the figures (the most completed first)", () => {
    const r = run([...busy, ...quiet]);
    const byCompleted = [...r.people]
      .sort((x, y) => y.completed - x.completed)
      .map((p) => p.person);
    expect(r.people.map((p) => p.person)).not.toEqual(byCompleted);
  });

  it("collates case and accents aside, in the reader's language", () => {
    expect(alphabetical(["Éva", "eszter", "Ádám", "Zita"], "hu-HU")).toEqual([
      "Ádám",
      "eszter",
      "Éva",
      "Zita",
    ]);
    expect(alphabetical(["b", "B", "a"])).toEqual(["a", "B", "b"]);
  });
});

describe("the business's own totals don't depend on who was on an appointment", () => {
  it("measures the business identically with the names removed", () => {
    const named = [
      ...many(25, (i) =>
        appt(i % 2 ? "Aoife" : "Marta", "completed", { price_minor: 1000, currency: "EUR" }),
      ),
      appt("Aoife", "no_show"),
    ];
    const nameless = named.map((a) => ({ ...a, staff_ref: null }));
    const opts = { lateSeparated: true, capacityPerWeek: 30, sourceName: "your bookings export" };
    expect(bookingMeasures(nameless, AS_OF, opts)).toEqual(bookingMeasures(named, AS_OF, opts));
    expect(run(nameless).unattributed).toBe(26);
    expect(run(nameless).people).toEqual([]);
  });
});
