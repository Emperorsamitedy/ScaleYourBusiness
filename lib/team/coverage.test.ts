// P5-19 — coverage by hour, pure. Every threshold has a passing and a
// failing side; rule 25's refusal says how much history there is; rule
// 28's names test proves a roster with names gives byte-identical output.

import { describe, expect, it } from "vitest";
import type { BookingStatus } from "../bookings/types";
import type { Weekday } from "../hours/schedule";
import type { CoverageInput, RoleInput, SlotInput } from "./coverage";
import { TEAM, rangeWords, rolesOf, teamCoverage } from "./coverage";

const AS_OF = "2026-10-24"; // a Saturday
const DAY_MS = 86_400_000;
const addDays = (day: string, n: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const WD: Weekday[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const weekdayOf = (day: string) => WD[new Date(`${day}T00:00:00Z`).getUTCDay()] as Weekday;

/** `perHour(weekday, hour, dayIndex)` held appointments, over `days` days to AS_OF. */
function slots(
  days: number,
  perHour: (w: Weekday, h: number, i: number) => number,
  status: BookingStatus = "completed",
): SlotInput[] {
  const out: SlotInput[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = addDays(AS_OF, -i);
    for (let h = 0; h < 24; h++) {
      const n = perHour(weekdayOf(day), h, i);
      for (let k = 0; k < n; k++) {
        out.push({
          day,
          start_time: `${String(h).padStart(2, "0")}:${k % 2 ? "30" : "00"}`,
          status,
        });
      }
    }
  }
  return out;
}

/** Saturdays only, 10:00–14:00 stated; a "Teacher" on 4 hours a week. */
function saturday(held: number, over: Partial<CoverageInput> = {}): CoverageInput {
  return {
    asOf: AS_OF,
    bookings: {
      source: "your bookings export",
      first_day: addDays(AS_OF, -55),
      slots: slots(56, (w, h) => (w === "sat" && h >= 10 && h < 14 ? held : 0)),
    },
    takings: null,
    capacityPerWeek: 25, // ÷ 4 open hours = 6.25 an hour
    openHours: { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [10, 11, 12, 13], sun: [] },
    season: { status: "unread", reason: "12 of the 50 complete weeks a season needs" },
    roles: [{ role_title: "Teacher", hours_per_week: 4 }],
    ...over,
  };
}

describe("teamCoverage — the bookings path", () => {
  it("says the role-level Saturday note in words, with its range and basis", () => {
    const r = teamCoverage(saturday(7));
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.headline).toBe(
      "Saturdays 10:00 to 14:00 ran 112% booked; one teacher covers about 6.3 appointments an hour at your stated 25 a week.",
    );
    const f = r.findings[0];
    expect(f?.band).toBe("short");
    expect(f?.range_words).toBe("(112% on every day of the middle half of the 8 Saturdays read)");
    expect(f?.note).toMatch(/demand ran past what your stated capacity covers/);
    expect(f?.note).toMatch(/another teacher would add cover first/);
    expect(r.basis).toMatchObject({ demand: "your bookings export", to: AS_OF, days_read: 8 });
    expect(r.capacity).toMatchObject({ per_week: 25, open_hours_per_week: 4, people_on: 1 });
    expect(r.assumed.join(" ")).toMatch(/25 appointments a week ÷ 4 open hours/);
    expect(r.assumed.join(" ")).toMatch(/I don't know the rota/);
  });

  /** Saturday 10:00–14:00 against a stated 20 a week (5 an hour), `at(i)` held at `hour` on the i-th Saturday. */
  const cellAt = (hour: number, at: (saturday: number) => number) => {
    const r = teamCoverage(
      saturday(0, {
        capacityPerWeek: 20,
        bookings: {
          source: "x",
          first_day: addDays(AS_OF, -55),
          slots: slots(56, (w, h, i) =>
            w === "sat" && h >= 10 && h < 14 ? (h === hour ? at(i / 7) : 3) : 0,
          ),
        },
      }),
    );
    if (r.status !== "ok") throw new Error("refused");
    return r.weekdays.find((w) => w.weekday === "sat")?.cells.find((c) => c.hour === hour);
  };

  it("bands an hour short when even the middle half's low end reaches the line, and not under it", () => {
    // 1 × 5 an hour. One Saturday at 4, seven at 5: the 25th percentile is 5, short.
    // Two at 4: it is 4.75 (95%), not short — however busy the typical day.
    expect(cellAt(10, (n) => (n < 1 ? 4 : 5))?.share?.low).toBe(TEAM.short_share);
    expect(cellAt(10, (n) => (n < 1 ? 4 : 5))?.band).toBe("short");
    expect(cellAt(10, (n) => (n < 2 ? 4 : 5))?.share?.low).toBeCloseTo(0.95, 10);
    expect(cellAt(10, (n) => (n < 2 ? 4 : 5))?.band).toBe("ok");
  });

  it("bands an open hour quiet when even the middle half's high end sits at the line, and not over it", () => {
    // 0.4 × 5 = 2. One Saturday at 3, seven at 2: the 75th percentile is 2, quiet.
    // Two at 3: it is 2.25 (45%), not quiet.
    expect(cellAt(13, (n) => (n < 1 ? 3 : 2))?.share?.high).toBe(TEAM.quiet_share);
    expect(cellAt(13, (n) => (n < 1 ? 3 : 2))?.band).toBe("quiet");
    expect(cellAt(13, (n) => (n < 2 ? 3 : 2))?.share?.high).toBeCloseTo(0.45, 10);
    expect(cellAt(13, (n) => (n < 2 ? 3 : 2))?.band).toBe("ok");
  });

  it("never bands an hour short on one busy day", () => {
    expect(cellAt(10, (n) => (n === 0 ? 20 : 3))?.share?.mean).toBeGreaterThan(1);
    expect(cellAt(10, (n) => (n === 0 ? 20 : 3))?.band).toBe("ok");
  });

  it("bands on the typical day, so one sick day or holiday doesn't move it", () => {
    const cell = cellAt(10, (n) => (n === 0 ? 1 : 5));
    expect(cell?.share?.mean).toBe(0.9); // (1 + 7 × 5) / 8 / 5
    expect(cell?.share?.typical).toBe(1);
    expect(cell?.band).toBe("short");
  });

  it("merges consecutive hours of one band into one finding, and keeps separate runs apart", () => {
    const r = teamCoverage(
      saturday(0, {
        bookings: {
          source: "x",
          first_day: addDays(AS_OF, -55),
          slots: slots(56, (w, h) => (w === "sat" ? ({ 10: 7, 11: 1, 12: 7, 13: 7 }[h] ?? 0) : 0)),
        },
      }),
    );
    if (r.status !== "ok") throw new Error("refused");
    const short = r.findings.filter((f) => f.band === "short").map((f) => [f.from_hour, f.to_hour]);
    expect(short).toEqual([
      [10, 11],
      [12, 14],
    ]);
    expect(r.findings.filter((f) => f.band === "quiet").map((f) => f.words)).toEqual([
      "Saturdays 11:00 to 12:00 ran 16% booked",
    ]);
  });

  it("does not band a weekday read on fewer than four days", () => {
    // 21 + 7 = 28 days of history but only three Saturdays in the window's open days
    const r = teamCoverage(
      saturday(6, {
        bookings: {
          source: "x",
          first_day: addDays(AS_OF, -27),
          slots: slots(28, (w, h, i) => (w === "sat" && h >= 10 && h < 14 && i < 21 ? 6 : 0)),
        },
        openHours: null,
      }),
    );
    if (r.status !== "ok") throw new Error("refused");
    const sat = r.weekdays.find((w) => w.weekday === "sat");
    expect(sat?.verdict).toBe("too_early");
    expect(sat?.days_read).toBe(3);
    expect(sat?.cells.every((c) => c.band === null)).toBe(true);
    expect(r.findings).toEqual([]);
  });

  it("reads open hours from when appointments start when they aren't stated, and says so", () => {
    const r = teamCoverage(saturday(6, { openHours: null }));
    if (r.status !== "ok") throw new Error("refused");
    expect(r.weekdays.find((w) => w.weekday === "sat")?.hours_from).toBe("bookings");
    expect(r.weekdays.find((w) => w.weekday === "mon")?.verdict).toBe("closed");
    expect(r.capacity?.open_hours_per_week).toBe(4);
    expect(r.assumed.join(" ")).toMatch(/Saturdays aren't stated, so they are read from when/);
  });

  it("counts held slots only: an early cancellation frees its slot", () => {
    const base = saturday(6);
    const cancelled = slots(56, (w, h) => (w === "sat" && h === 10 ? 6 : 0), "cancelled");
    const withCancels = teamCoverage({
      ...base,
      bookings: { ...base.bookings!, slots: [...base.bookings!.slots, ...cancelled] },
    });
    expect(JSON.stringify(withCancels)).toBe(JSON.stringify(teamCoverage(base)));
    const noShows = slots(56, (w, h) => (w === "sat" && h === 10 ? 1 : 0), "no_show");
    const withNoShows = teamCoverage({
      ...base,
      bookings: { ...base.bookings!, slots: [...base.bookings!.slots, ...noShows] },
    });
    if (withNoShows.status !== "ok") throw new Error("refused");
    const cell = withNoShows.weekdays.find((w) => w.weekday === "sat")?.cells[0];
    expect(cell?.demand?.mean).toBe(7); // a no-show still held the chair
  });
});

describe("rule 25 — refuses with too little, saying how much there is", () => {
  it("refuses at 27 days of bookings and reads at 28", () => {
    const at = (days: number) =>
      teamCoverage(
        saturday(6, {
          bookings: {
            source: "x",
            first_day: addDays(AS_OF, -(days - 1)),
            slots: slots(days, (w, h) => (w === "sat" && h >= 10 && h < 14 ? 6 : 0)),
          },
        }),
      );
    const r27 = at(27);
    expect(r27.status).toBe("refused");
    if (r27.status !== "refused") return;
    expect(r27.headline).toBe("27 days of bookings so far; cover by the hour needs 28.");
    expect(r27.history_days).toBe(27);
    expect(r27.ready_on).toBe(addDays(AS_OF, 1));
    expect(r27.cannot).toContain("borrow a pattern from other businesses like yours");
    expect(at(28).status).toBe("ok");
  });

  it("refuses without a stated weekly capacity rather than assuming one", () => {
    const r = teamCoverage(saturday(6, { capacityPerWeek: null }));
    expect(r.status).toBe("refused");
    if (r.status !== "refused") return;
    expect(r.reason).toMatch(/I won't assume one/);
    expect(teamCoverage(saturday(6, { capacityPerWeek: 25 })).status).toBe("ok");
  });

  it("refuses with nothing measuring demand, and still lists the roles", () => {
    const r = teamCoverage(saturday(6, { bookings: null }));
    expect(r.status).toBe("refused");
    if (r.status !== "refused") return;
    expect(r.history_days).toBe(0);
    expect(r.ready_on).toBeNull();
    expect(r.roles.map((x) => x.role)).toEqual(["Teacher"]);
  });

  it("refuses bookings without start times", () => {
    const base = saturday(6);
    const r = teamCoverage({
      ...base,
      bookings: {
        ...base.bookings!,
        slots: base.bookings!.slots.map((s) => ({ ...s, start_time: null })),
      },
    });
    expect(r.status).toBe("refused");
    if (r.status === "refused") expect(r.headline).toMatch(/no times/);
  });
});

describe("rule 28 — names are never read", () => {
  it("gives byte-identical output for a roster with names and the same roster without", () => {
    const plain: RoleInput[] = [
      { role_title: "Stylist", hours_per_week: 38 },
      { role_title: "Stylist", hours_per_week: 30 },
      { role_title: "Owner and senior stylist", hours_per_week: 45 },
      { role_title: "Receptionist", hours_per_week: null },
    ];
    // What a richer roster could carry: names, a person's tasks and costs,
    // and on the bookings, who served and who was served.
    const named = plain.map((r, i) => ({
      ...r,
      name: ["Aoife Byrne", "Sinead Walsh", "Niamh Kelly", "Marta Nowak"][i],
      first_name: ["Aoife", "Sinead", "Niamh", "Marta"][i],
      main_tasks: `${["Aoife", "Sinead", "Niamh", "Marta"][i]} does colour`,
      cost_monthly: { amount_minor: 210000 + i, currency: "EUR" },
      replaceability: i === 0 ? "single_point_of_failure" : "easy",
    }));
    const base = saturday(6, { openHours: null });
    const namedSlots = base.bookings!.slots.map((s, i) => ({
      ...s,
      staff_ref: ["Aoife", "Sinead", "Marta"][i % 3],
      client_key: `client-${i}`,
      service: "Colour",
    }));
    const without = teamCoverage({ ...base, roles: plain });
    const withNames = teamCoverage({
      ...base,
      roles: named,
      bookings: { ...base.bookings!, slots: namedSlots },
    });
    expect(JSON.stringify(withNames)).toBe(JSON.stringify(without));
    for (const n of ["Aoife", "Sinead", "Niamh", "Marta", "client-"]) {
      expect(JSON.stringify(withNames)).not.toContain(n);
    }
  });

  it("is not vacuous: a different role title does change the output", () => {
    const a = teamCoverage(saturday(6, { roles: [{ role_title: "Teacher", hours_per_week: 4 }] }));
    const b = teamCoverage(saturday(6, { roles: [{ role_title: "Aoife", hours_per_week: 4 }] }));
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });

  it("is the same bytes on every call", () => {
    expect(JSON.stringify(teamCoverage(saturday(6)))).toBe(
      JSON.stringify(teamCoverage(saturday(6))),
    );
  });
});

describe("rolesOf — roles grouped by title, never by row", () => {
  it("merges titles case- and space-blind, sums stated hours and counts the unstated", () => {
    const r = rolesOf(
      [
        { role_title: "Stylist", hours_per_week: 38 },
        { role_title: "  stylist ", hours_per_week: 30 },
        { role_title: "Stylist", hours_per_week: null },
        { role_title: "Receptionist", hours_per_week: 20 },
        { role_title: null, hours_per_week: 10 },
      ],
      40,
    );
    expect(r).toEqual([
      { role: "Stylist", rows: 3, hours_per_week: 68, unstated_rows: 1, on_per_open_hour: 1.7 },
      {
        role: "Receptionist",
        rows: 1,
        hours_per_week: 20,
        unstated_rows: 0,
        on_per_open_hour: 0.5,
      },
      {
        role: "Untitled role",
        rows: 1,
        hours_per_week: 10,
        unstated_rows: 0,
        on_per_open_hour: 0.25,
      },
    ]);
  });

  it("gives no people-on figure without stated hours", () => {
    expect(rolesOf([{ role_title: "Stylist", hours_per_week: null }], 40)[0]).toMatchObject({
      hours_per_week: null,
      on_per_open_hour: null,
    });
  });
});

describe("the busy season", () => {
  const lifted = (low: number) =>
    teamCoverage(
      saturday(0, {
        bookings: {
          source: "x",
          first_day: addDays(AS_OF, -55),
          // 4 / 6.25 = 0.64 at 13:00; 7 at 10–12 (already short)
          slots: slots(56, (w, h) => (w === "sat" && h >= 10 && h < 14 ? (h === 13 ? 4 : 7) : 0)),
        },
        season: {
          status: "busy_ahead",
          starts_on: "2026-12-01",
          ends_on: "2026-12-27",
          in_progress: false,
          index: 1.7,
          low,
          high: 1.9,
        },
      }),
    );

  it("names the hours even the low end of the busy stretch would push past capacity", () => {
    const r = lifted(1.6); // 0.64 × 1.6 = 1.024
    if (r.status !== "ok") throw new Error("refused");
    expect(r.season.extra).toEqual(["Saturdays 13:00 to 14:00"]);
    expect(r.season.words).toMatch(
      /^Your busy stretch starts on 1 Dec: last year it ran 1\.7× \(1\.6 to 1\.9×\)/,
    );
  });

  it("names none when the low end stays under the line", () => {
    const r = lifted(1.5); // 0.64 × 1.5 = 0.96
    if (r.status !== "ok") throw new Error("refused");
    expect(r.season.extra).toEqual([]);
    expect(r.season.words).toMatch(/no further hour/);
  });

  it("says plainly when the season can't be read yet", () => {
    const r = teamCoverage(saturday(6));
    if (r.status !== "ok") throw new Error("refused");
    expect(r.season.words).toBe(
      "The busy season isn't read yet: 12 of the 50 complete weeks a season needs.",
    );
  });
});

describe("teamCoverage — the takings path", () => {
  /** Saturdays 10–13: 100, 100, 100, then `last` at 13:00 (minor units). */
  const takings = (last: number, days = 56): CoverageInput => {
    const byDay = new Map<string, Map<number, number>>();
    const measured = new Map<Weekday, string[]>();
    for (let i = days - 1; i >= 0; i--) {
      const day = addDays(AS_OF, -i);
      const w = weekdayOf(day);
      measured.set(w, [...(measured.get(w) ?? []), day]);
      if (w === "sat")
        byDay.set(
          day,
          new Map([
            [10, 100],
            [11, 100],
            [12, 100],
            [13, last],
          ]),
        );
    }
    return {
      ...saturday(0),
      bookings: null,
      takings: {
        source: "card payments through shopify only",
        currency: "EUR",
        byDay,
        measuredDays: measured,
      },
    };
  };

  it("bands an hour quiet at a quarter of the day's busiest hour, and not over it", () => {
    const at = (last: number) => {
      const r = teamCoverage(takings(last));
      if (r.status !== "ok") throw new Error("refused");
      return r;
    };
    const quiet = at(25);
    expect(quiet.source).toBe("takings");
    expect(quiet.findings.map((f) => f.words)).toEqual([
      "Saturdays 13:00 to 14:00 took 25% of the day's busiest hour",
    ]);
    expect(at(26).findings).toEqual([]);
    // Takings can't say when demand runs over capacity.
    expect(quiet.weekdays.flatMap((w) => w.cells).some((c) => c.band === "short")).toBe(false);
    expect(quiet.notes.join(" ")).toMatch(/capacity isn't counted in money/);
  });

  it("refuses under 28 days of hourly sales", () => {
    const r = teamCoverage(takings(25, 20));
    expect(r.status).toBe("refused");
    if (r.status === "refused") expect(r.history_days).toBe(20);
  });
});

describe("P5-19 — a range in words", () => {
  it("prints a spread as low–high", () => {
    expect(rangeWords({ low: 1.03, high: 1.13 }, 8, "Fridays")).toBe(
      "(103–113% on the middle half of the 8 Fridays read)",
    );
  });

  it("never prints 113–113%: a range that collapsed says every day", () => {
    const words = rangeWords({ low: 1.13, high: 1.13 }, 8, "Thursdays");
    expect(words).toBe("(113% on every day of the middle half of the 8 Thursdays read)");
    expect(words).not.toMatch(/(\d+)–\1%/);
  });
});
