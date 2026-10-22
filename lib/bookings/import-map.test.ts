// specs/bookings-import-map-v1.json is data (rule 4); this holds it to its
// shape, and pins how headers, status words and dates are read.

import { describe, expect, it } from "vitest";
import {
  BOOKINGS_MAP,
  BOOKING_PLATFORMS,
  COLUMN_ROLES,
  mapColumns,
  normaliseName,
  squareStatusTarget,
  statusTarget,
} from "./import-map";
import {
  detectDelimiter,
  parseDateTime,
  parseDelimited,
  parseDuration,
  parseTime,
  slashEvidence,
} from "./parse";

const TARGETS = ["completed", "no_show", "cancelled_late", "cancelled", "booked", "accepted"];

describe("the map file's shape", () => {
  it("every role is explained, and only known roles and targets appear", () => {
    expect(Object.keys(BOOKINGS_MAP.roles).sort()).toEqual([...COLUMN_ROLES].sort());
    expect(Object.keys(BOOKINGS_MAP.generic.columns).sort()).toEqual([...COLUMN_ROLES].sort());
    for (const p of BOOKING_PLATFORMS) {
      const spec = BOOKINGS_MAP.platforms[p];
      expect(spec.label, p).not.toBe("");
      expect(spec.basis, p).not.toBe("");
      expect(typeof spec.verified, p).toBe("boolean");
      for (const role of Object.keys(spec.columns)) {
        expect(COLUMN_ROLES as readonly string[], `${p}.${role}`).toContain(role);
      }
      for (const target of Object.keys(spec.statuses)) {
        expect(TARGETS, `${p}.${target}`).toContain(target);
      }
    }
    for (const target of Object.values(BOOKINGS_MAP.square_api.statuses)) {
      expect(TARGETS).toContain(target);
    }
  });

  it("no status word means two things in one source", () => {
    const sources = [
      BOOKINGS_MAP.generic.statuses,
      ...BOOKING_PLATFORMS.map((p) => BOOKINGS_MAP.platforms[p].statuses),
    ];
    for (const source of sources) {
      const seen = new Map<string, string>();
      for (const [target, words] of Object.entries(source)) {
        for (const w of words ?? []) {
          const n = normaliseName(w);
          expect(seen.get(n) ?? target, `"${w}"`).toBe(target);
          seen.set(n, target);
        }
      }
    }
  });

  it("the generic statuses cover the closed set's words", () => {
    expect(statusTarget("Completed", "generic")).toBe("completed");
    expect(statusTarget("No-show", "generic")).toBe("no_show");
    expect(statusTarget("NO SHOW", "generic")).toBe("no_show");
    expect(statusTarget("Late cancel", "generic")).toBe("cancelled_late");
    expect(statusTarget("Canceled", "generic")).toBe("cancelled");
    expect(statusTarget("Confirmed", "generic")).toBe("booked");
    expect(statusTarget("Rescheduled-ish", "generic")).toBeNull();
    expect(statusTarget("", "generic")).toBeNull();
  });

  it("a platform's own words win over the generic ones", () => {
    expect(statusTarget("Signed in", "mindbody")).toBe("completed");
    expect(statusTarget("Finished", "booksy")).toBe("completed");
  });

  it("Square's enum: ACCEPTED is completed once past, PENDING never is", () => {
    expect(squareStatusTarget("ACCEPTED")).toBe("accepted");
    expect(squareStatusTarget("PENDING")).toBe("booked");
    expect(squareStatusTarget("NO_SHOW")).toBe("no_show");
    expect(squareStatusTarget("CANCELLED_BY_CUSTOMER")).toBe("cancelled");
    expect(squareStatusTarget("DECLINED")).toBe("cancelled");
    expect(squareStatusTarget("SOMETHING_NEW")).toBeNull();
  });
});

describe("headers", () => {
  it("normalises spelling, and the platform's names come first", () => {
    expect(normaliseName("Client e-mail")).toBe("clientemail");
    const header = ["Ref #", "Scheduled date", "Time", "Status", "Service", "Team member", "Price"];
    expect(mapColumns(header, "fresha")).toEqual({
      ref: 0,
      date: 1,
      time: 2,
      status: 3,
      service: 4,
      staff: 5,
      price: 6,
    });
  });

  it("a column serves one role only", () => {
    const map = mapColumns(["Date", "Status"], "generic");
    expect(map.date).toBe(0);
    expect(map.start).toBeUndefined();
  });
});

describe("cells", () => {
  it("detects , ; and tab", () => {
    expect(detectDelimiter("a;b;c\n1;2;3")).toBe(";");
    expect(detectDelimiter("a\tb\n1\t2")).toBe("\t");
    expect(detectDelimiter("a,b\n")).toBe(",");
    expect(parseDelimited('﻿a;"b;c"\n1;"say ""hi"""')).toEqual([
      ["a", "b;c"],
      ["1", 'say "hi"'],
    ]);
  });

  it("reads ISO, slash, dot and named dates; never guesses an ambiguous one", () => {
    expect(parseDateTime("2026-10-01", null)).toEqual({ day: "2026-10-01", time: null });
    expect(parseDateTime("2026-10-01T14:30:00Z", null)).toEqual({
      day: "2026-10-01",
      time: "14:30",
    });
    expect(parseDateTime("13/10/2026 9:05", null)).toEqual({ day: "2026-10-13", time: "09:05" });
    expect(parseDateTime("10/13/2026", null)).toEqual({ day: "2026-10-13", time: null });
    expect(parseDateTime("03/04/2026", null)).toBeNull();
    expect(parseDateTime("03/04/2026", "dmy")?.day).toBe("2026-04-03");
    expect(parseDateTime("03/04/2026", "mdy")?.day).toBe("2026-03-04");
    expect(parseDateTime("1.10.2026", "dmy")?.day).toBe("2026-10-01");
    expect(parseDateTime("1 Oct 2026", null)?.day).toBe("2026-10-01");
    expect(parseDateTime("October 1, 2026 2:30 pm", null)).toEqual({
      day: "2026-10-01",
      time: "14:30",
    });
    expect(parseDateTime("31/02/2026", "dmy")).toBeNull();
    expect(parseDateTime("1 Octopus 2026", null)).toBeNull();
    expect(parseDateTime("soon", null)).toBeNull();
  });

  it("slash evidence: the side above 12 is the day", () => {
    expect(slashEvidence("13/01/2026")).toBe("dmy");
    expect(slashEvidence("01/13/2026")).toBe("mdy");
    expect(slashEvidence("01/02/2026")).toBe("ambiguous");
    expect(slashEvidence("2026-01-02")).toBeNull();
  });

  it("times and durations", () => {
    expect(parseTime("14:30")).toBe("14:30");
    expect(parseTime("12:00 am")).toBe("00:00");
    expect(parseTime("12pm")).toBe("12:00");
    expect(parseTime("14")).toBeNull();
    expect(parseTime("25:00")).toBeNull();
    expect(parseDuration("45")).toBe(45);
    expect(parseDuration("45 min")).toBe(45);
    expect(parseDuration("1:15")).toBe(75);
    expect(parseDuration("1h 15m")).toBe(75);
    expect(parseDuration("a while")).toBeNull();
  });
});
