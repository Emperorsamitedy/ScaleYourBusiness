// Warnings sent at once: is a warning's line news? Pure.
//
// The watch writes a warning's line more often than the warning is new. A
// stock warning is said again each week for as long as it lasts
// (lib/stock/warnings: once a week per item and level), and a cash warning is
// written again whenever its first tight week moves (lib/watch/job), which a
// squeeze that carries on does every Monday. Those lines belong in the app
// and in Monday's summary. An alert is for news only:
//
//   - stock: the item was not said at this level, or a worse one, in the
//     eight days before;
//   - cash: no warning stood before it (none said yet, or the last one
//     cleared), or the week now said is a different squeeze from the one
//     that stood: wholly sooner, or more than a week after that one ended.
//
// A line that lacks the figures it should carry is not news. Silence costs
// the owner a day, until they open the app; a false alert costs their trust.

import type { CoverLevel } from "../stock/cover";

const DAY_MS = 86_400_000;

/** A stock warning said again within this many days is the same warning. */
export const STOCK_NEWS_WINDOW_DAYS = 8;

/**
 * A tight week that begins this many days or fewer after the standing one
 * ended is the same squeeze carrying on, not a new one.
 */
export const CASH_SAME_SQUEEZE_DAYS = 7;

/** How bad a stock warning is: a higher level is worse. */
const LEVEL_RANK: Readonly<Record<CoverLevel, number>> = {
  tight: 1,
  before_restock: 2,
};

const rank = (level: string | null): number =>
  level !== null && level in LEVEL_RANK ? LEVEL_RANK[level as CoverLevel] : 0;

/** A stock warning as its log line records it: which item, how bad. */
export interface SaidStock {
  key: string | null;
  level: string | null;
}

/**
 * `earlier` is what the watch said about stock for this business in the
 * STOCK_NEWS_WINDOW_DAYS before `line`. News unless the same item was said
 * then, as badly or worse.
 */
export function stockIsNews(earlier: readonly SaidStock[], line: SaidStock): boolean {
  if (line.key === null) return false;
  return !earlier.some((e) => e.key === line.key && rank(e.level) >= rank(line.level));
}

/** A cash warning's week as its log line records it. */
export interface SaidWeek {
  week_start: string | null;
  week_end: string | null;
}

/** The cash line that stood before another one. */
export interface StandingCash extends SaidWeek {
  /** True when that line said the warning no longer held. */
  cleared: boolean;
}

const dayOf = (iso: string): number => Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);

/**
 * `before` is the cash line written just before this one for the business,
 * or null when there is none. News when nothing stood, or when the tight week
 * now said neither overlaps the standing one nor follows straight on from it.
 */
export function cashIsNews(before: StandingCash | null, tight: SaidWeek): boolean {
  if (tight.week_start === null || tight.week_end === null) return false;
  if (before === null || before.cleared) return true;
  if (before.week_start === null || before.week_end === null) return false;
  const stoodFrom = dayOf(before.week_start);
  const stoodTo = dayOf(before.week_end);
  const from = dayOf(tight.week_start);
  const to = dayOf(tight.week_end);
  if ([stoodFrom, stoodTo, from, to].some((d) => Number.isNaN(d))) return false;
  const sooner = to < stoodFrom;
  const later = from > stoodTo + CASH_SAME_SQUEEZE_DAYS * DAY_MS;
  return sooner || later;
}
