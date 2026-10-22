// The bookings measures — every threshold pinned at its boundary, both ways
// (specs/bookings.md §4).

import { describe, expect, it } from "vitest";
import {
  BOOKING_WINDOW_DAYS,
  MIN_DUE_APPOINTMENTS,
  MIN_REBOOK_CLIENTS,
  REBOOK_DAYS,
  bookingMeasures,
  dailyBookingObservations,
  shiftDate,
} from "./measures";
import type { BookingStatus, MeasuredAppointment } from "./types";

const AS_OF = "2026-10-21";
const OPTS = { lateSeparated: true, capacityPerWeek: null, sourceName: "your bookings export" };

const appt = (
  day: string,
  status: BookingStatus,
  over: Partial<MeasuredAppointment> = {},
): MeasuredAppointment => ({
  day,
  status,
  client_key: null,
  price_minor: null,
  currency: null,
  ...over,
});

const many = (n: number, status: BookingStatus, day = AS_OF) =>
  Array.from({ length: n }, () => appt(day, status));

describe("the window", () => {
  it("is 28 days ending on the latest day, inclusive", () => {
    const m = bookingMeasures(
      [
        appt(AS_OF, "completed"),
        appt(shiftDate(AS_OF, -(BOOKING_WINDOW_DAYS - 1)), "completed"),
        appt(shiftDate(AS_OF, -BOOKING_WINDOW_DAYS), "completed"),
      ],
      AS_OF,
      OPTS,
    );
    expect(m.from).toBe("2026-09-24");
    expect(m.completed).toBe(2);
  });
});

describe("no-show and late-cancellation rates", () => {
  it(`below ${MIN_DUE_APPOINTMENTS} due appointments there is no rate`, () => {
    const m = bookingMeasures(
      [...many(MIN_DUE_APPOINTMENTS - 2, "completed"), ...many(1, "no_show")],
      AS_OF,
      OPTS,
    );
    expect(m.due).toBe(MIN_DUE_APPOINTMENTS - 1);
    expect(m.no_show_rate.status).toBe("unmeasured");
  });

  it(`at ${MIN_DUE_APPOINTMENTS} it is measured: no-shows ÷ (completed + no-shows + late)`, () => {
    const m = bookingMeasures(
      [
        ...many(16, "completed"),
        ...many(3, "no_show"),
        ...many(1, "cancelled_late"),
        ...many(7, "cancelled"), // released in time: not due
      ],
      AS_OF,
      OPTS,
    );
    expect(m.due).toBe(20);
    expect(m.no_show_rate).toMatchObject({ status: "measured", value: 15 });
    expect(m.late_cancellation_rate).toMatchObject({ status: "measured", value: 5 });
    expect(m.cancellations).toBe(7);
  });

  it("a source that doesn't separate late cancellations says so rather than zero", () => {
    const m = bookingMeasures(many(25, "completed"), AS_OF, {
      ...OPTS,
      lateSeparated: false,
      sourceName: "Square",
    });
    expect(m.late_cancellations).toBeNull();
    expect(m.late_cancellation_rate.status).toBe("unmeasured");
    expect(m.late_cancellation_rate).toMatchObject({ reason: expect.stringMatching(/Square/) });
  });
});

describe("rebooking", () => {
  const cohortDay = shiftDate(AS_OF, -REBOOK_DAYS); // the cohort's last day
  const clients = (n: number, prefix = "c") => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

  it("without any client identity it is unmeasured, plainly", () => {
    const m = bookingMeasures(many(30, "completed", cohortDay), AS_OF, OPTS);
    expect(m.rebooking_rate.status).toBe("unmeasured");
  });

  it(`below ${MIN_REBOOK_CLIENTS} cohort clients there is no rate; at it there is`, () => {
    const under = clients(MIN_REBOOK_CLIENTS - 1).map((c) =>
      appt(cohortDay, "completed", { client_key: c }),
    );
    expect(bookingMeasures(under, AS_OF, OPTS).rebooking_rate.status).toBe("unmeasured");
    const at = clients(MIN_REBOOK_CLIENTS).map((c) =>
      appt(cohortDay, "completed", { client_key: c }),
    );
    expect(bookingMeasures(at, AS_OF, OPTS).rebooking_rate).toMatchObject({
      status: "measured",
      value: 0,
    });
  });

  it(`a return on day ${REBOOK_DAYS} counts; on day ${REBOOK_DAYS + 1} it doesn't`, () => {
    const start = shiftDate(cohortDay, -10);
    const base = clients(10).map((c) => appt(start, "completed", { client_key: c }));
    const onTime = appt(shiftDate(start, REBOOK_DAYS), "completed", { client_key: "c0" });
    const tooLate = appt(shiftDate(start, REBOOK_DAYS + 1), "completed", { client_key: "c1" });
    const sameDay = appt(start, "completed", { client_key: "c2" }); // not "again"
    const cancelled = appt(shiftDate(start, 5), "cancelled", { client_key: "c3" }); // not held
    const noShow = appt(shiftDate(start, 5), "no_show", { client_key: "c4" }); // booked, held
    const m = bookingMeasures([...base, onTime, tooLate, sameDay, cancelled, noShow], AS_OF, OPTS);
    expect(m.rebooking_rate).toMatchObject({ status: "measured", value: 20 });
  });

  it("clients first seen after the cohort window aren't in it", () => {
    const base = clients(10).map((c) => appt(cohortDay, "completed", { client_key: c }));
    const tooNew = appt(shiftDate(cohortDay, 1), "completed", { client_key: "new" });
    const m = bookingMeasures([...base, tooNew], AS_OF, OPTS);
    expect(m.rebooking_rate).toMatchObject({
      arithmetic: expect.stringMatching(/^0 of 10 clients/),
    });
  });
});

describe("revenue and utilisation", () => {
  it("sums completed appointments' prices only", () => {
    const m = bookingMeasures(
      [
        appt(AS_OF, "completed", { price_minor: 12_000, currency: "HUF" }),
        appt(AS_OF, "completed", { price_minor: 8_000, currency: "HUF" }),
        appt(AS_OF, "no_show", { price_minor: 99_999, currency: "HUF" }),
        appt(AS_OF, "completed"),
      ],
      AS_OF,
      OPTS,
    );
    expect(m.revenue).toMatchObject({
      status: "measured",
      value: { amount_minor: 20_000, currency: "HUF" },
    });
  });

  it("two currencies refuse rather than blend; no prices is unmeasured", () => {
    const two = bookingMeasures(
      [
        appt(AS_OF, "completed", { price_minor: 1, currency: "HUF" }),
        appt(AS_OF, "completed", { price_minor: 1, currency: "EUR" }),
      ],
      AS_OF,
      OPTS,
    );
    expect(two.revenue.status).toBe("unmeasured");
    expect(bookingMeasures(many(3, "completed"), AS_OF, OPTS).revenue.status).toBe("unmeasured");
  });

  it("utilisation only with a stated capacity above zero", () => {
    const appts = many(40, "completed");
    expect(bookingMeasures(appts, AS_OF, OPTS).utilisation.status).toBe("unmeasured");
    expect(bookingMeasures(appts, AS_OF, { ...OPTS, capacityPerWeek: 0 }).utilisation.status).toBe(
      "unmeasured",
    );
    expect(bookingMeasures(appts, AS_OF, { ...OPTS, capacityPerWeek: 20 }).utilisation).toEqual({
      status: "measured",
      value: 50,
      arithmetic: expect.stringContaining(
        "40 completed of a stated 20 a week × 4 weeks = 80 slots",
      ),
    });
  });
});

describe("daily observations", () => {
  it("every day in the range, zeros included; revenue only with prices", () => {
    const obs = dailyBookingObservations(
      [
        appt("2026-10-01", "completed", { price_minor: 5_000, currency: "EUR" }),
        appt("2026-10-01", "no_show"),
        appt("2026-10-03", "cancelled_late"),
        appt("2026-10-03", "booked_future"),
      ],
      "2026-10-01",
      "2026-10-03",
      "2026-10-22T00:00:00.000Z",
      { lateSeparated: true },
    );
    const at = (metric: string, day: string) =>
      obs.find((o) => o.metric_key === metric && o.period_date === day);
    expect(at("appointments_completed.daily", "2026-10-01")?.value_num).toBe(1);
    expect(at("appointments_no_show.daily", "2026-10-01")?.value_num).toBe(1);
    expect(at("appointments_completed.daily", "2026-10-02")?.value_num).toBe(0);
    expect(at("appointments_cancelled_late.daily", "2026-10-03")?.value_num).toBe(1);
    expect(at("booking_revenue.daily", "2026-10-01")?.value_minor).toBe(5_000);
    expect(at("booking_revenue.daily", "2026-10-02")?.value_minor).toBe(0);
    expect(obs.filter((o) => o.period_date === "2026-10-02")).toHaveLength(5);
  });

  it("no late-cancellation series from a source that doesn't separate them", () => {
    const obs = dailyBookingObservations(
      [appt("2026-10-01", "completed")],
      "2026-10-01",
      "2026-10-01",
      "2026-10-22T00:00:00.000Z",
      { lateSeparated: false },
    );
    expect(obs.map((o) => o.metric_key).sort()).toEqual([
      "appointments_cancelled.daily",
      "appointments_completed.daily",
      "appointments_no_show.daily",
    ]);
  });
});
