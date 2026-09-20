// Day windows for store connectors (Shopify, WooCommerce).
//
// Every store connector reads UTC calendar days, oldest first, in fixed
// windows, and resumes from a cursor naming the last complete day. Two
// store-specific facts shape the plan:
//
//   · history — how far back the platform lets this credential see;
//   · re-read — how many recent days every sync reads again, because a
//     refund changes an order that was already counted.
//
// The last complete day is yesterday; today is still being written.

import { ProviderError } from "./provider";

const DAY_MS = 86_400_000;

export function utcMidnight(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

export function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * DAY_MS);
}

export function dayString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** ISO 8601 to the second, with a Z: what store search filters accept. */
export function isoSeconds(d: Date): string {
  return `${d.toISOString().slice(0, 19)}Z`;
}

export function parseCursor(cursor: string, provider: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(cursor)) {
    throw new ProviderError(`${provider}: malformed cursor "${cursor}"`);
  }
  return new Date(`${cursor}T00:00:00Z`);
}

export interface WindowPlan {
  start: Date;
  /** Inclusive. */
  end: Date;
  /** The first day after the cursor, or null on a first sync. */
  resume: Date | null;
  yesterday: Date;
}

/** The next window to read, or null when there is nothing left to read. */
export function planWindow(args: {
  cursor: string | null;
  now: Date;
  historyDays: number;
  rereadDays: number;
  windowDays: number;
  provider: string;
}): WindowPlan | null {
  const yesterday = addDays(utcMidnight(args.now), -1);
  const earliest = addDays(yesterday, -(args.historyDays - 1));
  const tailStart = addDays(yesterday, -(args.rereadDays - 1));
  const resume = args.cursor === null ? null : addDays(parseCursor(args.cursor, args.provider), 1);

  // Re-read the tail only once the connection has caught up (its cursor is
  // at least the day before yesterday): that is when earlier days were read
  // by a PREVIOUS run and a refund may have changed them since. A backfill
  // still in progress just continues; re-reading days it fetched moments
  // ago in the same run would cost calls and find nothing new.
  const caughtUp = resume !== null && resume.getTime() >= yesterday.getTime();
  let start: Date;
  if (resume === null) start = earliest;
  else if (caughtUp) start = tailStart;
  else start = resume;
  // Never ask for days the credential cannot see.
  if (start.getTime() < earliest.getTime()) start = earliest;
  if (start.getTime() > yesterday.getTime()) return null;

  const end = new Date(
    Math.min(addDays(start, args.windowDays - 1).getTime(), yesterday.getTime()),
  );
  return { start, end, resume, yesterday };
}

/**
 * The single NEW day to read when a window is too busy: the day after the
 * cursor, so the cursor always advances and a busy stretch cannot stall.
 * Null when there is no new day left.
 */
export function oneNewDay(plan: WindowPlan): Date | null {
  const day =
    plan.resume !== null && plan.resume.getTime() >= plan.start.getTime()
      ? plan.resume
      : plan.start;
  return day.getTime() > plan.yesterday.getTime() ? null : day;
}

/** The cursor after reading through `end`. It never moves backwards. */
export function advanceCursor(cursor: string | null, end: Date): string {
  const endDay = dayString(end);
  return cursor !== null && cursor > endDay ? cursor : endDay;
}
