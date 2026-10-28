// Coverage by hour — P5-19 (Phase 5 Session E, step 93). Pure: no
// database, no clock, no model. Client-safe: it imports types and pure
// helpers only, so the /team screen can lay out what /api/team returns.
//
// Rule 28: staff planning is about ROLES, never people. What this reads,
// and all it reads:
//
//   demand   when appointments started and whether they held a slot (day,
//            start time, status: nothing about the client or who served
//            them), or hourly takings where there are no bookings, and the
//            busy season ahead from the business's own last year;
//   supply   the stated weekly capacity (1.4.2.3b), the stated opening
//            hours, and for each 9.2 row its role title and its hours a
//            week. A row's other answers are never inputs, and a name,
//            wherever one turns up, is never read: a test passes a roster
//            with names and proves the output is byte-identical without.
//
// Nothing here scores, ranks or compares anyone. The output is hours of
// the week, banded against the stated capacity, with roles as the only
// unit of supply, and notes for the owner that never name a person.
//
// The arithmetic (every threshold below is named and pinned by a test):
//
//   window     the last TEAM.window_days days to `asOf` (eight of each weekday)
//   held       completed + no-show + late-cancelled: the slots still held
//              when their time came. An appointment counts in its start hour.
//   open hours the owner's stated opening hours; where a weekday's hours
//              aren't stated, the hours appointments start in on at least
//              TEAM.footprint_share of that weekday's days (ASSUMED)
//   capacity   the stated appointments a week ÷ the open hours a week, the
//              same in every open hour (ASSUMED)
//   share      held in the hour ÷ capacity per open hour, per day; the cell
//              reports its typical day — the mean of the middle half of
//              the days, the lowest and highest quarter left out, so one
//              sick day or holiday doesn't move it — and the middle half
//              itself as the range (p25–p75)
//   short      even the low end of the middle half ≥ TEAM.short_share
//              (100%): on most days demand ran past what the stated
//              capacity covers. One busy day never makes an hour short.
//   quiet      even the high end of the middle half ≤ TEAM.quiet_share:
//              open, and little demand on most days
//   roles      role hours a week ÷ open hours a week = people of that role
//              on in an average open hour (ASSUMED: the rota isn't known)
//
// Rule 25: below TEAM.min_history_days of history it refuses, saying how
// much there is, what it can and can't say, and when it will be ready. It
// never borrows another business's pattern.

import type { BookingStatus } from "../bookings/types";
import type { Weekday } from "../hours/schedule";

export const TEAM_WEEKDAYS: readonly Weekday[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

export const TEAM = {
  /** Days read, ending on `asOf`: eight of each weekday. */
  window_days: 56,
  /** Below this many days of history the reading refuses (rule 25). */
  min_history_days: 28,
  /** A weekday read on fewer days than this is too early to band. */
  min_days_per_weekday: 4,
  /** An hour whose middle half of days all reach this ran past what the stated capacity covers. */
  short_share: 1,
  /** An open hour whose middle half of days all sit at or below this is quiet. */
  quiet_share: 0.4,
  /** Without stated hours, an hour counts as open when appointments start in it on this share of days. */
  footprint_share: 0.25,
  /** Takings: an open hour at or under this share of the day's busiest hour is quiet. */
  quiet_takings_share: 0.25,
} as const;

/** The statuses that held a slot when its time came. */
const HELD: ReadonlySet<BookingStatus> = new Set(["completed", "no_show", "cancelled_late"]);

/** One appointment as this module reads it: when, and whether it held a slot. Nothing else. */
export interface SlotInput {
  /** "YYYY-MM-DD", the business's own date. */
  day: string;
  /** "HH:MM", or null when the source gave no time. */
  start_time: string | null;
  status: BookingStatus;
}

/** One 9.2 row as this module reads it: its role and its hours. Nothing else. */
export interface RoleInput {
  role_title: string | null;
  hours_per_week: number | null;
}

export interface TakingsInput {
  /** Where the takings were measured, in words (lib/hours/coverage). */
  source: string;
  currency: string;
  /** Trading day → trading hour → takings, minor units. */
  byDay: ReadonlyMap<string, ReadonlyMap<number, number>>;
  /** The measured trading days of each weekday. */
  measuredDays: ReadonlyMap<Weekday, readonly string[]>;
}

export type SeasonInput =
  | { status: "unread"; reason: string }
  | { status: "none_ahead" }
  | {
      status: "busy_ahead";
      starts_on: string;
      ends_on: string;
      in_progress: boolean;
      index: number;
      low: number;
      high: number | null;
    };

export interface CoverageInput {
  /** The last day read ("YYYY-MM-DD"). */
  asOf: string;
  /** Bookings: the slots in the window, the source in words, and the first day ever booked. */
  bookings: { source: string; first_day: string | null; slots: readonly SlotInput[] } | null;
  /** Hourly takings, read when there are no bookings to hold against capacity. */
  takings: TakingsInput | null;
  /** The owner's stated appointments a week (service.capacity_per_week), or null. */
  capacityPerWeek: number | null;
  /** Stated opening hours: weekday → its open trading hours. A weekday absent is unstated. */
  openHours: Partial<Record<Weekday, readonly number[]>> | null;
  season: SeasonInput;
  roles: readonly RoleInput[];
}

export type Band = "short" | "ok" | "quiet";

export interface Spread {
  mean: number;
  /** The typical day (the middle half's mean): what bands an hour and what its words say. */
  typical: number;
  low: number;
  high: number;
}

export interface HourCell {
  hour: number;
  open: boolean;
  /** Held appointments (bookings) or takings in minor units (takings), per day. */
  demand: Spread | null;
  /** Share of the capacity per open hour (bookings) or of the day's busiest hour (takings). */
  share: Spread | null;
  band: Band | null;
}

export interface WeekdayCover {
  weekday: Weekday;
  days_read: number;
  verdict: "read" | "too_early" | "closed";
  /** How this weekday's open hours are known. */
  hours_from: "stated" | "bookings" | "takings" | null;
  cells: HourCell[];
}

export interface RoleCover {
  /** The role title as the owner wrote it ("Untitled role" when none). */
  role: string;
  /** How many 9.2 rows share this title. */
  rows: number;
  /** Their stated hours a week, summed; null when none of them stated hours. */
  hours_per_week: number | null;
  /** Rows of this role whose hours weren't stated. */
  unstated_rows: number;
  /** People of this role on in an average open hour (ASSUMED even spread); null without hours. */
  on_per_open_hour: number | null;
}

export interface CoverFinding {
  weekday: Weekday;
  from_hour: number;
  /** Exclusive: 10 to 14 is "10:00–14:00". */
  to_hour: number;
  band: "short" | "quiet";
  share: Spread;
  days: number;
  /** "Saturdays 10:00–14:00 ran 96% booked". */
  words: string;
  /** "(91–100% on the middle half of the 8 Saturdays read)". */
  range_words: string;
  /** "one stylist covers about 1 appointment an hour". */
  reason: string;
  /** A note for the owner about the hours and the role: never about a person. */
  note: string;
}

export interface Capacity {
  per_week: number;
  open_hours_per_week: number;
  per_open_hour: number;
  /** Total people on in an average open hour, from the role hours; null without any. */
  people_on: number | null;
  /** Capacity per person on (per_open_hour ÷ people_on); null without role hours. */
  per_person_on: number | null;
}

export type CoverageResult =
  | {
      status: "refused";
      headline: string;
      reason: string;
      /** Days of history there are, and the minimum. */
      history_days: number;
      needed_days: number;
      /** When it will be ready if the data keeps coming; null when nothing is coming. */
      ready_on: string | null;
      can: string[];
      cannot: string[];
      roles: RoleCover[];
      limits: string[];
    }
  | {
      status: "ok";
      source: "bookings" | "takings";
      headline: string;
      basis: {
        /** Where demand was read, in words. */
        demand: string;
        from: string;
        to: string;
        history_days: number;
        days_read: number;
        currency: string | null;
      };
      hours: number[];
      weekdays: WeekdayCover[];
      roles: RoleCover[];
      capacity: Capacity | null;
      findings: CoverFinding[];
      season: { words: string; extra: string[] };
      assumed: string[];
      notes: string[];
      limits: string[];
    };

const DAY_MS = 86_400_000;

function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);
}

function weekdayOf(day: string): Weekday {
  const wd = new Date(`${day}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  return TEAM_WEEKDAYS[(wd + 6) % 7] as Weekday;
}

/** Linear-interpolated quantile (the spreadsheet's PERCENTILE). */
function quantile(values: readonly number[], q: number): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const a = s[lo] as number;
  const b = s[hi] as number;
  return a + (b - a) * (pos - lo);
}

/** The mean of the middle half: the lowest and highest quarter of the values left out. */
function middleMean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const cut = Math.floor(s.length / 4);
  const mid = s.slice(cut, s.length - cut);
  return mid.reduce((t, v) => t + v, 0) / mid.length;
}

function spreadOf(values: readonly number[]): Spread {
  const mean = values.length === 0 ? 0 : values.reduce((s, v) => s + v, 0) / values.length;
  return {
    mean,
    typical: middleMean(values),
    low: quantile(values, 0.25),
    high: quantile(values, 0.75),
  };
}

const PLURAL: Record<Weekday, string> = {
  mon: "Mondays",
  tue: "Tuesdays",
  wed: "Wednesdays",
  thu: "Thursdays",
  fri: "Fridays",
  sat: "Saturdays",
  sun: "Sundays",
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "1 Dec", in UTC so server and browser agree. */
export function dayText(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

const pct = (x: number) => Math.round(x * 100);

/**
 * "(91–100% on the middle half of the 8 Saturdays read)", or, when the
 * middle half all ran the same, "(113% on every day of the middle half of
 * the 8 Thursdays read)" rather than "113–113%".
 */
export function rangeWords(
  share: { low: number; high: number },
  days: number,
  plural: string,
): string {
  const low = pct(share.low);
  const high = pct(share.high);
  return low === high
    ? `(${low}% on every day of the middle half of the ${days} ${plural} read)`
    : `(${low}–${high}% on the middle half of the ${days} ${plural} read)`;
}
const one = (x: number) => Math.round(x * 10) / 10;

/** "Saturdays", "Fridays and Saturdays", "Tuesdays to Saturdays" (three or more in a row). */
export function daysText(days: readonly Weekday[]): string {
  const idx = days.map((d) => TEAM_WEEKDAYS.indexOf(d)).sort((a, b) => a - b);
  const names = idx.map((i) => PLURAL[TEAM_WEEKDAYS[i] as Weekday]);
  const consecutive = idx.every((v, i) => i === 0 || v === (idx[i - 1] ?? -2) + 1);
  if (names.length >= 3 && consecutive) return `${names[0]} to ${names.at(-1)}`;
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** "10:00", on the 24-hour clock (25 is 01:00 after midnight). */
export function clock(hour: number): string {
  return `${String(hour % 24).padStart(2, "0")}:00`;
}

/** "Saturdays 10:00–14:00". */
export function runText(weekday: Weekday, from: number, to: number): string {
  return `${PLURAL[weekday]} ${clock(from)}–${clock(to)}`;
}

/** "1 appointment", "2.7 appointments". */
function appts(x: number): string {
  const v = one(x);
  return `${v} appointment${v === 1 ? "" : "s"}`;
}

/** The title in running text: "Stylist" → "stylist"; "HR lead" stays. */
function inText(title: string): string {
  const second = title.charAt(1);
  return second !== "" && second === second.toLowerCase() && second !== second.toUpperCase()
    ? title.charAt(0).toLowerCase() + title.slice(1)
    : title;
}

/**
 * The roles from 9.2, grouped by title (case and spacing ignored), the
 * biggest first. Only the title and the hours are read from a row.
 */
export function rolesOf(roles: readonly RoleInput[], openHoursPerWeek: number | null): RoleCover[] {
  const groups = new Map<string, { role: string; rows: number; hours: number; stated: number }>();
  for (const r of roles) {
    const title =
      typeof r.role_title === "string" && r.role_title.trim() !== ""
        ? r.role_title.trim().replace(/\s+/g, " ")
        : "Untitled role";
    const key = title.toLowerCase();
    const g = groups.get(key) ?? { role: title, rows: 0, hours: 0, stated: 0 };
    g.rows += 1;
    const h = r.hours_per_week;
    if (typeof h === "number" && Number.isFinite(h) && h > 0) {
      g.hours += h;
      g.stated += 1;
    }
    groups.set(key, g);
  }
  return [...groups.values()]
    .map((g) => ({
      role: g.role,
      rows: g.rows,
      hours_per_week: g.stated > 0 ? g.hours : null,
      unstated_rows: g.rows - g.stated,
      on_per_open_hour:
        g.stated > 0 && openHoursPerWeek !== null && openHoursPerWeek > 0
          ? g.hours / openHoursPerWeek
          : null,
    }))
    .sort(
      (a, b) =>
        (b.hours_per_week ?? -1) - (a.hours_per_week ?? -1) ||
        (a.role < b.role ? -1 : a.role > b.role ? 1 : 0),
    );
}

const LIMITS = [
  "This reads roles and hours only. It never looks at who worked when, and it says nothing about any person.",
  "The notes are for you to weigh. Nothing changes a rota, a shift or anyone's hours.",
];

/** Contiguous runs of the same band on one weekday, in hour order. */
function runsOf(w: WeekdayCover, band: "short" | "quiet"): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  for (const c of w.cells) {
    if (c.open && c.band === band) {
      const last = out.at(-1);
      if (last && last.to === c.hour) last.to = c.hour + 1;
      else out.push({ from: c.hour, to: c.hour + 1 });
    }
  }
  return out;
}

function refuse(args: {
  headline: string;
  reason: string;
  history: number;
  readyOn: string | null;
  can: string[];
  cannot: string[];
  roles: readonly RoleInput[];
}): CoverageResult {
  return {
    status: "refused",
    headline: args.headline,
    reason: args.reason,
    history_days: args.history,
    needed_days: TEAM.min_history_days,
    ready_on: args.readyOn,
    can: args.can,
    cannot: args.cannot,
    roles: rolesOf(args.roles, null),
    limits: LIMITS,
  };
}

const CANNOT = [
  "say which hours run over what your stated capacity covers",
  "say which open hours are quiet",
  "borrow a pattern from other businesses like yours",
];

function hourOf(start: string | null): number | null {
  if (start === null) return null;
  const m = /^(\d{1,2}):(\d{2})/.exec(start);
  if (!m) return null;
  const h = Number(m[1]);
  return h >= 0 && h <= 23 ? h : null;
}

/** The busy stretch ahead, in words, and the hours it would push past capacity. */
function seasonPart(
  season: SeasonInput,
  weekdays: readonly WeekdayCover[],
  canProject: boolean,
): { words: string; extra: string[] } {
  if (season.status === "unread") {
    return { words: `The busy season isn't read yet: ${season.reason}.`, extra: [] };
  }
  if (season.status === "none_ahead") {
    return {
      words: "No busy stretch in the next eight weeks, going by the same weeks last year.",
      extra: [],
    };
  }
  const when = season.in_progress ? "is under way" : `starts on ${dayText(season.starts_on)}`;
  const range =
    season.high === null
      ? `at least ${one(season.low)}×`
      : `${one(season.low)}–${one(season.high)}×`;
  const head = `Your busy stretch ${when}: last year it ran ${one(season.index)}× (${range}) your normal week.`;
  if (!canProject) return { words: head, extra: [] };
  // Only what even the low ends imply: hours not already short whose
  // lower-quarter share × the season's low multiple reaches the short line.
  const extra: string[] = [];
  for (const w of weekdays) {
    if (w.verdict !== "read") continue;
    let run: { from: number; to: number } | null = null;
    const flush = () => {
      if (run) extra.push(runText(w.weekday, run.from, run.to));
      run = null;
    };
    for (const c of w.cells) {
      const lifts =
        c.open &&
        c.band !== "short" &&
        c.share !== null &&
        c.share.low * season.low >= TEAM.short_share;
      if (lifts) {
        if (run && run.to === c.hour) run.to = c.hour + 1;
        else {
          flush();
          run = { from: c.hour, to: c.hour + 1 };
        }
      } else flush();
    }
    flush();
  }
  return {
    words:
      extra.length === 0
        ? `${head} Even at its low end, no further hour would run past your stated capacity.`
        : `${head} At its low end, these hours would also run past your stated capacity: ${extra.join("; ")}.`,
    extra,
  };
}

/** P5-19: coverage by hour. Pure; the same input always gives the same bytes. */
export function teamCoverage(input: CoverageInput): CoverageResult {
  const { asOf, roles } = input;
  const from = addDays(asOf, -(TEAM.window_days - 1));
  const bookings =
    input.bookings !== null && input.bookings.slots.length > 0 ? input.bookings : null;
  const capacity =
    input.capacityPerWeek !== null &&
    Number.isFinite(input.capacityPerWeek) &&
    input.capacityPerWeek > 0
      ? input.capacityPerWeek
      : null;

  if (bookings !== null && (capacity !== null || input.takings === null)) {
    return fromBookings(input, bookings, capacity, from);
  }
  if (input.takings !== null) return fromTakings(input, input.takings, from);
  return refuse({
    headline: "Nothing measures demand by the hour yet.",
    reason:
      "Cover by the hour needs your bookings (an export, or Square) or hourly sales from a connected till, payment account or shop.",
    history: 0,
    readyOn: null,
    can: ["list the roles you gave me and their hours"],
    cannot: CANNOT,
    roles,
  });
}

function fromBookings(
  input: CoverageInput,
  bookings: NonNullable<CoverageInput["bookings"]>,
  capacity: number | null,
  windowFrom: string,
): CoverageResult {
  const { asOf, roles } = input;
  const firstDay =
    bookings.first_day ??
    bookings.slots.reduce((m, s) => (s.day < m ? s.day : m), bookings.slots[0]?.day ?? asOf);
  const history = Math.max(0, daysBetween(firstDay, asOf) + 1);
  if (history < TEAM.min_history_days) {
    return refuse({
      headline: `${history} day${history === 1 ? "" : "s"} of bookings so far; cover by the hour needs ${TEAM.min_history_days}.`,
      reason: `Your bookings run from ${dayText(firstDay)} to ${dayText(asOf)}. Four of each weekday is the least I'll band an hour on.`,
      history,
      readyOn: addDays(firstDay, TEAM.min_history_days - 1),
      can: [`count the appointments in the ${history} days there are`],
      cannot: CANNOT,
      roles,
    });
  }
  if (capacity === null) {
    return refuse({
      headline: "Your weekly capacity isn't stated, so I can't say when demand runs over it.",
      reason:
        "You haven't told me how many appointments you can take a week (question 1.4.2.3b), and I won't assume one.",
      history,
      readyOn: null,
      can: ["count the appointments by the hour"],
      cannot: CANNOT.slice(0, 2),
      roles,
    });
  }

  const start = firstDay > windowFrom ? firstDay : windowFrom;
  const inWindow = bookings.slots.filter((s) => s.day >= start && s.day <= asOf);
  const placed = inWindow.filter((s) => hourOf(s.start_time) !== null);
  const unplaced = inWindow.length - placed.length;
  if (placed.length === 0) {
    return refuse({
      headline: "Your bookings have no times, so they can't be read by the hour.",
      reason: `None of the ${inWindow.length} appointments from ${dayText(start)} to ${dayText(asOf)} says when it started.`,
      history,
      readyOn: null,
      can: ["count appointments by the day"],
      cannot: CANNOT,
      roles,
    });
  }

  // Per day: any appointment at all (the day was trading), and held per hour.
  const anyOn = new Set<string>();
  const held = new Map<string, Map<number, number>>();
  const startsIn = new Map<string, Set<number>>();
  for (const s of placed) {
    const h = hourOf(s.start_time) as number;
    anyOn.add(s.day);
    const st = startsIn.get(s.day) ?? new Set<number>();
    st.add(h);
    startsIn.set(s.day, st);
    if (!HELD.has(s.status)) continue;
    const m = held.get(s.day) ?? new Map<number, number>();
    m.set(h, (m.get(h) ?? 0) + 1);
    held.set(s.day, m);
  }

  const datesOf = (w: Weekday): string[] => {
    const out: string[] = [];
    for (let d = start; d <= asOf; d = addDays(d, 1)) if (weekdayOf(d) === w) out.push(d);
    return out;
  };

  // Each weekday's days and open hours.
  const plan = TEAM_WEEKDAYS.map((weekday) => {
    const dates = datesOf(weekday);
    const stated = input.openHours?.[weekday];
    if (stated !== undefined) {
      return {
        weekday,
        days: stated.length === 0 ? [] : dates,
        open: new Set(stated),
        from: "stated" as const,
      };
    }
    const days = dates.filter((d) => anyOn.has(d));
    if (days.length === 0 || days.length < dates.length * TEAM.footprint_share) {
      return { weekday, days: [], open: new Set<number>(), from: null };
    }
    const open = new Set<number>();
    for (let h = 0; h < 24; h++) {
      const n = days.filter((d) => startsIn.get(d)?.has(h)).length;
      if (n >= days.length * TEAM.footprint_share) open.add(h);
    }
    return { weekday, days, open, from: "bookings" as const };
  });

  const openHoursPerWeek = plan.reduce((s, p) => s + (p.days.length > 0 ? p.open.size : 0), 0);
  if (openHoursPerWeek === 0) {
    return refuse({
      headline: "No open hours could be read from your bookings.",
      reason: "No weekday had appointments on enough of its days to say when you are open.",
      history,
      readyOn: null,
      can: ["count appointments by the day"],
      cannot: CANNOT,
      roles,
    });
  }
  const perOpenHour = capacity / openHoursPerWeek;
  const roleCover = rolesOf(roles, openHoursPerWeek);
  const roleHours = roleCover.reduce((s, r) => s + (r.hours_per_week ?? 0), 0);
  const peopleOn = roleHours > 0 ? roleHours / openHoursPerWeek : null;
  const perPersonOn = peopleOn !== null ? perOpenHour / peopleOn : null;

  const hourSet = new Set<number>();
  for (const p of plan) if (p.days.length > 0) for (const h of p.open) hourSet.add(h);
  const lo = Math.min(...hourSet);
  const hi = Math.max(...hourSet);
  const hours = Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);

  const weekdays: WeekdayCover[] = plan.map((p) => {
    if (p.days.length === 0) {
      return {
        weekday: p.weekday,
        days_read: 0,
        verdict: "closed",
        hours_from: p.from,
        cells: hours.map((hour) => ({ hour, open: false, demand: null, share: null, band: null })),
      };
    }
    const early = p.days.length < TEAM.min_days_per_weekday;
    return {
      weekday: p.weekday,
      days_read: p.days.length,
      verdict: early ? "too_early" : "read",
      hours_from: p.from,
      cells: hours.map((hour): HourCell => {
        if (!p.open.has(hour)) return { hour, open: false, demand: null, share: null, band: null };
        const counts = p.days.map((d) => held.get(d)?.get(hour) ?? 0);
        const demand = spreadOf(counts);
        const share = spreadOf(counts.map((c) => c / perOpenHour));
        const band: Band | null = early
          ? null
          : share.low >= TEAM.short_share
            ? "short"
            : share.high <= TEAM.quiet_share
              ? "quiet"
              : "ok";
        return { hour, open: true, demand, share, band };
      }),
    };
  });

  const lead = roleCover.find((r) => r.hours_per_week !== null) ?? null;
  const findings: CoverFinding[] = [];
  for (const w of weekdays) {
    if (w.verdict !== "read") continue;
    const days = plan.find((p) => p.weekday === w.weekday)?.days ?? [];
    for (const band of ["short", "quiet"] as const) {
      for (const run of runsOf(w, band)) {
        const len = run.to - run.from;
        const perDay = days.map((d) => {
          let n = 0;
          for (let h = run.from; h < run.to; h++) n += held.get(d)?.get(h) ?? 0;
          return n / (perOpenHour * len);
        });
        const share = spreadOf(perDay);
        const where = runText(w.weekday, run.from, run.to);
        const range_words = rangeWords(share, days.length, PLURAL[w.weekday]);
        const reason =
          band === "short"
            ? lead !== null && perPersonOn !== null
              ? `one ${inText(lead.role)} covers about ${appts(perPersonOn)} an hour at your stated ${capacity} a week`
              : `your stated ${capacity} a week is about ${appts(perOpenHour)} an hour`
            : peopleOn !== null
              ? `about ${one(peopleOn)} people are on in an average open hour, by the role hours you gave`
              : `your stated ${capacity} a week is about ${appts(perOpenHour)} an hour`;
        const note =
          band === "short"
            ? `${where}: demand ran past what your stated capacity covers. If you want to take more of it, this is where another ${lead !== null ? inText(lead.role) : "pair of hands"} would add cover first.`
            : `${where}: the quietest open stretch. If you ever trim the rota, this is where it would cost the least demand.`;
        findings.push({
          weekday: w.weekday,
          from_hour: run.from,
          to_hour: run.to,
          band,
          share,
          days: days.length,
          words: `${where} ran ${pct(share.typical)}% booked`,
          range_words,
          reason,
          note,
        });
      }
    }
  }
  // Busiest short first, then the quietest; ties in week order.
  const order = (f: CoverFinding) => TEAM_WEEKDAYS.indexOf(f.weekday) * 100 + f.from_hour;
  findings.sort((a, b) =>
    a.band !== b.band
      ? a.band === "short"
        ? -1
        : 1
      : a.band === "short"
        ? b.share.typical - a.share.typical || order(a) - order(b)
        : a.share.typical - b.share.typical || order(a) - order(b),
  );

  const footprint = plan.filter((p) => p.from === "bookings" && p.days.length > 0);
  const assumed = [
    `capacity is the same in every open hour: your stated ${capacity} appointments a week ÷ ${openHoursPerWeek} open hours = ${appts(perOpenHour)} an hour`,
    "an appointment counts in the hour it starts",
    ...(footprint.length > 0
      ? [
          `opening hours for ${daysText(footprint.map((p) => p.weekday))} aren't stated, so they are read from when appointments start (on at least ${pct(TEAM.footprint_share)}% of those days)`,
        ]
      : []),
    ...(peopleOn !== null
      ? [
          "role hours are spread evenly over the open hours: I don't know the rota",
          "every role you listed counts toward serving clients",
        ]
      : []),
  ];

  const notes = findings.map((f) => f.note);
  if (roleCover.length === 0) {
    notes.push(
      "No roles from the interview (who works in the business, and their hours), so this is demand against capacity only.",
    );
  }
  if (unplaced > 0) {
    notes.push(
      `${unplaced} appointment${unplaced === 1 ? "" : "s"} had no start time and aren't placed in an hour.`,
    );
  }

  const top = findings[0];
  const headline =
    top === undefined
      ? "No open hour runs over your stated capacity or sits quiet."
      : top.band === "short"
        ? `${top.words}; ${top.reason}.`
        : `No open hour runs over your stated capacity; ${top.words.charAt(0).toLowerCase()}${top.words.slice(1)}.`;
  const daysRead = plan.reduce((s, p) => s + p.days.length, 0);

  return {
    status: "ok",
    source: "bookings",
    headline,
    basis: {
      demand: bookings.source,
      from: start,
      to: asOf,
      history_days: history,
      days_read: daysRead,
      currency: null,
    },
    hours,
    weekdays,
    roles: roleCover,
    capacity: {
      per_week: capacity,
      open_hours_per_week: openHoursPerWeek,
      per_open_hour: perOpenHour,
      people_on: peopleOn,
      per_person_on: perPersonOn,
    },
    findings,
    season: seasonPart(input.season, weekdays, true),
    assumed,
    notes,
    limits: LIMITS,
  };
}

function fromTakings(
  input: CoverageInput,
  takings: TakingsInput,
  windowFrom: string,
): CoverageResult {
  const { asOf, roles } = input;
  const all = [...takings.measuredDays.values()].flat().filter((d) => d <= asOf);
  const first = all.reduce<string | null>((m, d) => (m === null || d < m ? d : m), null);
  const history = first === null ? 0 : daysBetween(first, asOf) + 1;
  if (first === null || history < TEAM.min_history_days) {
    return refuse({
      headline: `${history} day${history === 1 ? "" : "s"} of hourly sales so far; cover by the hour needs ${TEAM.min_history_days}.`,
      reason:
        first === null
          ? "No day of hourly sales is measured yet."
          : `Hourly sales run from ${dayText(first)} to ${dayText(asOf)}. Four of each weekday is the least I'll band an hour on.`,
      history,
      readyOn: first === null ? null : addDays(first, TEAM.min_history_days - 1),
      can: ["show the hourly sales there are on Trading hours"],
      cannot: CANNOT,
      roles,
    });
  }

  const plan = TEAM_WEEKDAYS.map((weekday) => {
    const days = (takings.measuredDays.get(weekday) ?? []).filter(
      (d) => d >= windowFrom && d <= asOf,
    );
    const stated = input.openHours?.[weekday];
    if (stated !== undefined) {
      return {
        weekday,
        days: stated.length === 0 ? [] : days,
        open: new Set(stated),
        from: "stated" as const,
      };
    }
    const sold = days.filter((d) => [...(takings.byDay.get(d)?.values() ?? [])].some((v) => v > 0));
    if (sold.length === 0 || sold.length < days.length * TEAM.footprint_share) {
      return { weekday, days: [], open: new Set<number>(), from: null };
    }
    const open = new Set<number>();
    for (let h = 0; h < 30; h++) {
      const n = sold.filter((d) => (takings.byDay.get(d)?.get(h) ?? 0) > 0).length;
      if (n >= sold.length * TEAM.footprint_share) open.add(h);
    }
    return { weekday, days: sold, open, from: "takings" as const };
  });

  const openHoursPerWeek = plan.reduce((s, p) => s + (p.days.length > 0 ? p.open.size : 0), 0);
  const hourSet = new Set<number>();
  for (const p of plan) if (p.days.length > 0) for (const h of p.open) hourSet.add(h);
  if (hourSet.size === 0) {
    return refuse({
      headline: "No open hours could be read from your sales.",
      reason: "No weekday had sales on enough of its days to say when you are open.",
      history,
      readyOn: null,
      can: ["show the hourly sales there are on Trading hours"],
      cannot: CANNOT,
      roles,
    });
  }
  const lo = Math.min(...hourSet);
  const hi = Math.max(...hourSet);
  const hours = Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
  const roleCover = rolesOf(roles, openHoursPerWeek);
  const roleHours = roleCover.reduce((s, r) => s + (r.hours_per_week ?? 0), 0);
  const peopleOn = roleHours > 0 ? roleHours / openHoursPerWeek : null;

  const weekdays: WeekdayCover[] = plan.map((p) => {
    if (p.days.length === 0) {
      return {
        weekday: p.weekday,
        days_read: 0,
        verdict: "closed",
        hours_from: p.from,
        cells: hours.map((hour) => ({ hour, open: false, demand: null, share: null, band: null })),
      };
    }
    const early = p.days.length < TEAM.min_days_per_weekday;
    const typical = new Map<number, number>();
    for (const h of p.open) {
      typical.set(
        h,
        quantile(
          p.days.map((d) => takings.byDay.get(d)?.get(h) ?? 0),
          0.5,
        ),
      );
    }
    const peak = Math.max(0, ...typical.values());
    return {
      weekday: p.weekday,
      days_read: p.days.length,
      verdict: early ? "too_early" : "read",
      hours_from: p.from,
      cells: hours.map((hour): HourCell => {
        if (!p.open.has(hour)) return { hour, open: false, demand: null, share: null, band: null };
        const values = p.days.map((d) => takings.byDay.get(d)?.get(hour) ?? 0);
        const demand = spreadOf(values);
        const share = peak > 0 ? spreadOf(values.map((v) => v / peak)) : null;
        const band: Band | null =
          early || share === null ? null : share.high <= TEAM.quiet_takings_share ? "quiet" : "ok";
        return { hour, open: true, demand, share, band };
      }),
    };
  });

  const findings: CoverFinding[] = [];
  for (const w of weekdays) {
    if (w.verdict !== "read") continue;
    const days = plan.find((p) => p.weekday === w.weekday)?.days ?? [];
    const peak = Math.max(0, ...w.cells.map((c) => c.demand?.typical ?? 0));
    if (peak <= 0) continue;
    for (const run of runsOf(w, "quiet")) {
      const len = run.to - run.from;
      const perDay = days.map((d) => {
        let n = 0;
        for (let h = run.from; h < run.to; h++) n += takings.byDay.get(d)?.get(h) ?? 0;
        return n / (peak * len);
      });
      const share = spreadOf(perDay);
      const where = runText(w.weekday, run.from, run.to);
      findings.push({
        weekday: w.weekday,
        from_hour: run.from,
        to_hour: run.to,
        band: "quiet",
        share,
        days: days.length,
        words: `${where} took ${pct(share.typical)}% of the day's busiest hour`,
        range_words: rangeWords(share, days.length, PLURAL[w.weekday]),
        reason:
          peopleOn !== null
            ? `about ${one(peopleOn)} people are on in an average open hour, by the role hours you gave`
            : "the hours are open",
        note: `${where}: the quietest open stretch by takings. If you ever trim the rota, this is where it would cost the least demand.`,
      });
    }
  }
  const order = (f: CoverFinding) => TEAM_WEEKDAYS.indexOf(f.weekday) * 100 + f.from_hour;
  findings.sort((a, b) => a.share.typical - b.share.typical || order(a) - order(b));

  const footprint = plan.filter((p) => p.from === "takings" && p.days.length > 0);
  const assumed = [
    "takings stand in for demand: a sale in an hour is a customer served in it",
    ...(footprint.length > 0
      ? [
          `opening hours for ${daysText(footprint.map((p) => p.weekday))} aren't stated, so they are read from when sales come in`,
        ]
      : []),
    ...(peopleOn !== null
      ? ["role hours are spread evenly over the open hours: I don't know the rota"]
      : []),
  ];
  const notes = findings.map((f) => f.note);
  notes.push(
    "Takings can't show when demand runs past your capacity: capacity isn't counted in money. A bookings export can.",
  );
  if (roleCover.length === 0) {
    notes.push(
      "No roles from the interview (who works in the business, and their hours), so this is demand only.",
    );
  }
  const top = findings[0];
  return {
    status: "ok",
    source: "takings",
    headline:
      top === undefined
        ? "No open hour sits quiet against the day's busiest."
        : `${top.words}; ${top.reason}.`,
    basis: {
      demand: takings.source,
      from: windowFrom > first ? windowFrom : first,
      to: asOf,
      history_days: history,
      days_read: plan.reduce((s, p) => s + p.days.length, 0),
      currency: takings.currency,
    },
    hours,
    weekdays,
    roles: roleCover,
    capacity: null,
    findings,
    season: seasonPart(input.season, weekdays, false),
    assumed,
    notes,
    limits: LIMITS,
  };
}
