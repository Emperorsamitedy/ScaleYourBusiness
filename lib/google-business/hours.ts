// One opening or closing time moved on a Google listing — I-45a lifted
// (2026-11-16), for the hours trials (lib/hours/trials.ts). Pure.
//
// A change names a weekday, which edge (open or close), the time it is now
// and the time it becomes, each in minutes from the start of that weekday:
// a close after midnight is past 1440 (Friday's 01:00 close is 1500). That
// is how a trading day counts its hours (lib/hours/trading: 25 = 01:00
// after midnight), so a trial's hour maps across without a calendar.
//
// Google's shape (specs/google-business-api-v1.md): a TimePeriod is
// {openDay, openTime, closeDay, closeTime}; times run 00:00–24:00, 24:00
// meaning midnight at the end of that day; zero values are left out of the
// JSON ({} for 00:00). A close at midnight may come back as 24:00 on the
// same day or 00:00 on the next — both read as 1440.
//
// moveEdge changes exactly one period's one edge, and only when Google's
// listing says what the approval assumed: the edge at `from`. Already at
// `to` (an earlier attempt landed, its answer lost) is "already". Anything
// else is refused, in words, and nothing is sent: the listing is the owner's
// and has moved since the approval.

import type { Weekday } from "../hours/schedule";

/** lib/hours/schedule's WEEKDAYS, kept here so the provider map imports no database. */
const WEEKDAYS: readonly Weekday[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

export const GOOGLE_DAYS = [
  "MONDAY",
  "TUESDAY",
  "WEDNESDAY",
  "THURSDAY",
  "FRIDAY",
  "SATURDAY",
  "SUNDAY",
] as const;
export type GoogleDay = (typeof GOOGLE_DAYS)[number];

export interface GbpTime {
  hours?: number;
  minutes?: number;
}

export interface GbpPeriod {
  openDay: GoogleDay;
  openTime: GbpTime;
  closeDay: GoogleDay;
  closeTime: GbpTime;
}

export type HoursEdge = "open" | "close";

export interface HoursChange {
  weekday: Weekday;
  edge: HoursEdge;
  /** Minutes from the start of the weekday, as the listing says now. */
  from: number;
  /** Minutes from the start of the weekday, as approved. */
  to: number;
}

const DAY_MIN = 1440;

export function googleDay(w: Weekday): GoogleDay {
  return GOOGLE_DAYS[WEEKDAYS.indexOf(w)] as GoogleDay;
}

function readTime(raw: unknown): GbpTime | null {
  if (raw === undefined) return {};
  if (raw === null || typeof raw !== "object") return null;
  const t = raw as Record<string, unknown>;
  const h = t["hours"] ?? 0;
  const m = t["minutes"] ?? 0;
  if (typeof h !== "number" || typeof m !== "number") return null;
  if (!Number.isInteger(h) || !Number.isInteger(m) || h < 0 || h > 24 || m < 0 || m > 59) {
    return null;
  }
  if (h === 24 && m !== 0) return null;
  return { ...(h ? { hours: h } : {}), ...(m ? { minutes: m } : {}) };
}

/** Pure: Google's periods, checked; null when any of them isn't one. */
export function readPeriods(raw: readonly unknown[]): GbpPeriod[] | null {
  const out: GbpPeriod[] = [];
  for (const p of raw) {
    if (p === null || typeof p !== "object") return null;
    const r = p as Record<string, unknown>;
    const openDay = r["openDay"];
    const closeDay = r["closeDay"];
    if (!GOOGLE_DAYS.includes(openDay as GoogleDay)) return null;
    if (!GOOGLE_DAYS.includes(closeDay as GoogleDay)) return null;
    const openTime = readTime(r["openTime"]);
    const closeTime = readTime(r["closeTime"]);
    if (openTime === null || closeTime === null) return null;
    out.push({
      openDay: openDay as GoogleDay,
      openTime,
      closeDay: closeDay as GoogleDay,
      closeTime,
    });
  }
  return out;
}

const minutesOf = (t: GbpTime) => (t.hours ?? 0) * 60 + (t.minutes ?? 0);

function daysAfter(from: GoogleDay, to: GoogleDay): number {
  return (GOOGLE_DAYS.indexOf(to) - GOOGLE_DAYS.indexOf(from) + 7) % 7;
}

/** Pure: the period's opening, in minutes from the start of its open day. */
export function openMinutes(p: GbpPeriod): number {
  return minutesOf(p.openTime);
}

/** Pure: the period's closing, in minutes from the start of its OPEN day (past 1440 after midnight). */
export function closeMinutes(p: GbpPeriod): number {
  const days = daysAfter(p.openDay, p.closeDay);
  const close = days * DAY_MIN + minutesOf(p.closeTime);
  // A period that closes "earlier" on the same day wraps a whole week (Google's own reading).
  return close <= openMinutes(p) ? close + 7 * DAY_MIN : close;
}

/** Pure: minutes from the start of `day` as Google's day and time; 1440 is 24:00 that day. */
function toGoogle(day: GoogleDay, minutes: number): { day: GoogleDay; time: GbpTime } {
  const shift = minutes > DAY_MIN ? Math.floor((minutes - 1) / DAY_MIN) : 0;
  const within = minutes - shift * DAY_MIN;
  const d = GOOGLE_DAYS[(GOOGLE_DAYS.indexOf(day) + shift) % 7] as GoogleDay;
  const h = Math.floor(within / 60);
  const m = within % 60;
  return { day: d, time: { ...(h ? { hours: h } : {}), ...(m ? { minutes: m } : {}) } };
}

/** Pure: "09:00", "01:00 after midnight". */
export function clockWords(minutes: number): string {
  const within = minutes % DAY_MIN;
  const hh = String(Math.floor(within / 60)).padStart(2, "0");
  const mm = String(within % 60).padStart(2, "0");
  if (minutes === DAY_MIN) return "midnight";
  return minutes > DAY_MIN ? `${hh}:${mm} after midnight` : `${hh}:${mm}`;
}

export type MoveResult =
  | { kind: "moved"; periods: GbpPeriod[]; index: number }
  | { kind: "already"; index: number }
  | { kind: "refused"; reason: string };

const DAY_NAME: Readonly<Record<Weekday, string>> = {
  mon: "Mondays",
  tue: "Tuesdays",
  wed: "Wednesdays",
  thu: "Thursdays",
  fri: "Fridays",
  sat: "Saturdays",
  sun: "Sundays",
};

/** Pure: is this a change ScaleX may make at all? Null when it is. */
export function changeProblem(c: HoursChange): string | null {
  if (!WEEKDAYS.includes(c.weekday)) return "the change names no weekday";
  if (c.edge !== "open" && c.edge !== "close") return "the change names no opening or closing";
  for (const v of [c.from, c.to]) {
    if (!Number.isInteger(v) || v < 0 || v > 2 * DAY_MIN) return "the change names no time";
  }
  if (c.edge === "open" && (c.from >= DAY_MIN || c.to >= DAY_MIN)) {
    return "an opening time has to fall on its own day";
  }
  if (c.from === c.to) return "the change moves nothing";
  return null;
}

/**
 * Pure: the listing with one edge moved, if the listing says what the
 * approval assumed. The period is the one opening on the weekday whose edge
 * sits at `from` — exactly one, or nothing is changed.
 */
export function moveEdge(periods: readonly GbpPeriod[], c: HoursChange): MoveResult {
  const problem = changeProblem(c);
  if (problem !== null) return { kind: "refused", reason: problem };
  const day = googleDay(c.weekday);
  const edgeOf = (p: GbpPeriod) => (c.edge === "open" ? openMinutes(p) : closeMinutes(p));
  const onDay = periods.map((p, i) => ({ p, i })).filter(({ p }) => p.openDay === day);
  const at = (m: number) => onDay.filter(({ p }) => edgeOf(p) === m);
  const fromHits = at(c.from);
  const toHits = at(c.to);
  const what = c.edge === "open" ? "open" : "close";
  if (fromHits.length === 0) {
    if (toHits.length === 1) return { kind: "already", index: toHits[0]!.i };
    return {
      kind: "refused",
      reason: `Your Google listing doesn't say you ${what} at ${clockWords(c.from)} on ${DAY_NAME[c.weekday]}, so ScaleX didn't change it: your hours on Google have moved since this was approved.`,
    };
  }
  if (fromHits.length > 1) {
    return {
      kind: "refused",
      reason: `Your Google listing has more than one period that ${what}s at ${clockWords(c.from)} on ${DAY_NAME[c.weekday]}, so ScaleX didn't guess which to change.`,
    };
  }
  const { p, i } = fromHits[0]!;
  const next: GbpPeriod = { ...p };
  if (c.edge === "open") {
    if (c.to >= closeMinutes(p)) {
      return { kind: "refused", reason: "that opening time would come after closing" };
    }
    next.openTime = toGoogle(day, c.to).time;
  } else {
    if (c.to <= openMinutes(p)) {
      return { kind: "refused", reason: "that closing time would come before opening" };
    }
    const g = toGoogle(day, c.to);
    next.closeDay = g.day;
    next.closeTime = g.time;
  }
  const out = periods.map((x, j) => (j === i ? next : x));
  return { kind: "moved", periods: out, index: i };
}
