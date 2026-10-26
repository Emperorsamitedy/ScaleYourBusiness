// The weekly summary's calendar — idea 42. Pure.
//
// One email per account per ISO week (UTC): the week key is the
// idempotency key, so a cron that fires twice on a Monday, or is re-run by
// hand on the Wednesday, finds the week already claimed. What the email
// covers is the seven days up to the moment it is composed — the weekly
// beat runs every Monday, so consecutive emails tile the calendar.

import { parseInstant } from "../watch/watch-view";

const DAY_MS = 86_400_000;

/** "2026-W44": the ISO 8601 week-numbering year and week of an instant, in UTC. */
export function isoWeek(at: Date): string {
  const day = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  // ISO weeks start on Monday; the week belongs to the year of its Thursday.
  const weekday = day.getUTCDay() === 0 ? 7 : day.getUTCDay();
  day.setUTCDate(day.getUTCDate() + 4 - weekday);
  const yearStart = Date.UTC(day.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((day.getTime() - yearStart) / DAY_MS + 1) / 7);
  return `${day.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export interface SummaryWindow {
  /** Exclusive lower bound, ISO instant. */
  from: string;
  /** Inclusive upper bound, ISO instant. */
  to: string;
}

/** The seven days the email reports on, ending now. */
export function summaryWindow(now: Date): SummaryWindow {
  return {
    from: new Date(now.getTime() - 7 * DAY_MS).toISOString(),
    to: now.toISOString(),
  };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** A Postgres timestamp ("2026-10-27 00:00:00+00") or an ISO string, as a Date. */
export function instant(at: string): Date {
  return new Date(parseInstant(at));
}

/** "Mon 20 Oct" in UTC, as the watch screen prints a day. */
export function dayLabel(at: string): string {
  const d = instant(at);
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** "20 Oct – 26 Oct 2026": the window as the email's heading prints it. */
export function windowLabel(w: SummaryWindow): string {
  const a = instant(w.from);
  const b = instant(w.to);
  return `${a.getUTCDate()} ${MONTHS[a.getUTCMonth()]} – ${b.getUTCDate()} ${MONTHS[b.getUTCMonth()]} ${b.getUTCFullYear()}`;
}
