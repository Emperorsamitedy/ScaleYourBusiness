// Reading a bookings export (specs/bookings.md §3): statuses normalise to
// the closed set, unreadable rows are counted and left out, money is minor
// units in the batch's currency, and no client identity leaves the reader.

import { describe, expect, it } from "vitest";
import { BookingImportError, LATE_CANCEL_HOURS, readExport } from "./rows";
import type { ClientIdentity } from "./types";

const TODAY = "2026-10-22";
const keyOf = (i: ClientIdentity) => `k(${i.kind}:${i.value.trim().toLowerCase()})`;
const read = (csv: string, over: Partial<Parameters<typeof readExport>[1]> = {}) =>
  readExport(
    csv,
    { platform: "generic", currency: "EUR", dateOrder: null, today: TODAY, ...over },
    keyOf,
  );

describe("statuses", () => {
  it("normalise to the closed set; a booking on or before today is not closed out", () => {
    const r = read(
      [
        "Date,Time,Status,Service,Email,Price",
        "2026-10-01,10:00,Completed,Cut,anna@example.com,40.00",
        "2026-10-01,11:00,No-show,Cut,bea@example.com,40.00",
        "2026-10-01,12:00,Late cancel,Colour,cili@example.com,90",
        "2026-10-01,13:00,Cancelled,Cut,dora@example.com,40",
        "2026-10-30,10:00,Confirmed,Cut,anna@example.com,40",
        "2026-10-22,10:00,Booked,Cut,eva@example.com,40",
        "2026-10-02,10:00,Rescheduled?,Cut,eva@example.com,40",
        "2026-10-02,10:00,,Cut,eva@example.com,40",
        ",10:00,Completed,Cut,eva@example.com,40",
        "someday,10:00,Completed,Cut,eva@example.com,40",
      ].join("\n"),
    );
    expect(r.rows_read).toBe(10);
    expect(r.appointments.map((a) => a.status)).toEqual([
      "completed",
      "no_show",
      "cancelled_late",
      "cancelled",
      "booked_future",
    ]);
    expect(r.skipped).toEqual({
      not_closed_out: 1,
      unknown_status: 1,
      no_status: 1,
      no_date: 1,
      unreadable_date: 1,
    });
    expect(r.unknown_statuses).toEqual({ "Rescheduled?": 1 });
  });

  it(`a plain cancellation under ${LATE_CANCEL_HOURS} hours before the start is late; at it, it isn't`, () => {
    const r = read(
      [
        "Date,Time,Status,Cancelled at",
        "2026-10-02,10:00,Cancelled,2026-10-01 10:01",
        "2026-10-02,10:00,Cancelled,2026-10-01 10:00",
        "2026-10-02,10:00,Cancelled,2026-10-01", // no clock: never judged late
      ].join("\n"),
    );
    expect(r.appointments.map((a) => a.status)).toEqual([
      "cancelled_late",
      "cancelled",
      "cancelled",
    ]);
    expect(r.gaps.cancelled_at).toBe(1);
  });
});

describe("money, identity and keys", () => {
  it("prices are integer minor units in the batch currency; unreadable ones are counted", () => {
    const r = read(
      ["Date,Status,Price", "2026-10-01,Completed,1 234,50", "2026-10-01,Completed,free"].join(
        "\n",
      ),
      { currency: "huf" },
    );
    // "1 234" then ",50" is a column shift in a comma file: only the first cell is the price.
    expect(r.appointments[0]?.price_minor).toBe(123_400);
    expect(r.appointments[0]?.currency).toBe("HUF");
    expect(r.appointments[1]?.price_minor).toBeNull();
    expect(r.gaps.price).toBe(1);
  });

  it("a price column needs a named currency (rule 1)", () => {
    expect(() => read("Date,Status,Price\n2026-10-01,Completed,10", { currency: null })).toThrow(
      BookingImportError,
    );
  });

  it("no status column, no date column: the file is refused, not guessed", () => {
    expect(() => read("Date,Service\n2026-10-01,Cut")).toThrow(/status column/);
    expect(() => read("Status,Service\nCompleted,Cut")).toThrow(/date column/);
  });

  it("the client id wins over email; the reader hands back only the key", () => {
    const r = read(
      [
        "Date,Status,Client ID,Email,Client",
        "2026-10-01,Completed,C-9,anna@example.com,Anna K",
      ].join("\n"),
    );
    expect(r.identity).toBe("client_id");
    expect(r.appointments[0]?.client).toEqual({ kind: "keyed", key: "k(id:c-9)" });
    expect(JSON.stringify(r)).not.toContain("anna@example.com");
    expect(JSON.stringify(r)).not.toContain("Anna K");
  });

  it("names alone are not an identity", () => {
    const r = read(["Date,Status,Client", "2026-10-01,Completed,Anna"].join("\n"));
    expect(r.identity).toBeNull();
    expect(r.appointments[0]?.client).toBeNull();
  });

  it("a booking reference is the key; repeated lines of one booking merge", () => {
    const r = read(
      [
        "Ref #,Date,Status,Service,Price",
        "B-1,2026-10-01,Completed,Cut,40",
        "B-1,2026-10-01,Completed,Colour,60",
        "B-2,2026-10-01,No show,Cut,40",
      ].join("\n"),
    );
    expect(r.appointments.map((a) => [a.source_ref, a.price_minor])).toEqual([
      ["generic:ref:B-1", 10_000],
      ["generic:ref:B-2", 4_000],
    ]);
    expect(r.merged_lines).toBe(1);
  });

  it("without a reference, identical rows (a class) stay distinct and keys are stable", () => {
    const csv = ["Date,Time,Status,Class", ...Array(3).fill("2026-10-01,18:00,Attended,Spin")].join(
      "\n",
    );
    const a = read(csv);
    const b = read(csv);
    expect(a.appointments).toHaveLength(3);
    expect(new Set(a.appointments.map((x) => x.source_ref)).size).toBe(3);
    expect(b.appointments.map((x) => x.source_ref)).toEqual(
      a.appointments.map((x) => x.source_ref),
    );
  });
});

describe("dates", () => {
  it("ambiguous slash dates need the owner's order; the file's own proof wins", () => {
    const ambiguous = "Date,Status\n03/04/2026,Completed";
    expect(() => read(ambiguous)).toThrow(/day or the month/);
    expect(read(ambiguous, { dateOrder: "dmy" }).appointments[0]?.day).toBe("2026-04-03");
    const proven = read("Date,Status\n03/04/2026,Completed\n25/04/2026,Completed");
    expect(proven.date_order).toEqual({ order: "dmy", proven: true });
    expect(proven.appointments[0]?.day).toBe("2026-04-03");
    expect(() => read("Date,Status\n13/01/2026,Completed\n01/13/2026,Completed")).toThrow(
      /both day-first and month-first/,
    );
  });

  it("a semicolon export with a datetime column reads the same", () => {
    const r = read("Start;Status;Staff\n2026-10-01 14:30;Completed;Kata", { platform: "fresha" });
    expect(r.appointments[0]).toMatchObject({
      day: "2026-10-01",
      start_time: "14:30",
      staff_ref: "Kata",
    });
    expect(r.columns).toEqual({ start: "Start", status: "Status", staff: "Staff" });
  });
});

describe("prices written the European way (review 2026-10-23, #4)", () => {
  it("a lone 1.200 asks which mark separates thousands; the owner's answer reads it exactly", () => {
    const csv = "Date,Status,Price\n2026-10-01,Completed,12.000\n2026-10-02,Completed,1.200";
    expect(() => read(csv, { currency: "HUF" })).toThrow(/dot or the comma separates thousands/);
    const dot = read(csv, { currency: "HUF", decimalStyle: "comma_decimal" });
    expect(dot.appointments.map((a) => a.price_minor)).toEqual([1_200_000, 120_000]);
    const comma = read(csv, { currency: "EUR", decimalStyle: "dot_decimal" });
    expect(comma.appointments.map((a) => a.price_minor)).toEqual([1_200, 120]);
  });

  it("a file that proves its style settles 1.200 itself; one that proves both is refused", () => {
    const proven = read(
      "Date;Status;Price\n2026-10-01;Completed;1.200\n2026-10-02;Completed;12,50",
    );
    expect(proven.appointments.map((a) => a.price_minor)).toEqual([120_000, 1_250]);
    expect(() =>
      read("Date;Status;Price\n2026-10-01;Completed;1.234,56\n2026-10-02;Completed;1,234.56"),
    ).toThrow(/written both ways/);
    expect(() =>
      read("Date;Status;Price\n2026-10-01;Completed;12,50", { decimalStyle: "dot_decimal" }),
    ).toThrow(/only read the other way/);
  });

  it("no float: 1.234 EUR in a dot-decimal file is too precise and counted, never rounded to 123", () => {
    const r = read("Date,Status,Price\n2026-10-01,Completed,1.234", {
      decimalStyle: "dot_decimal",
    });
    expect(r.appointments[0]?.price_minor).toBeNull();
    expect(r.gaps.price).toBe(1);
  });
});
