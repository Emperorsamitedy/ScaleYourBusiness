// Insights · Trading hours, said plainly (2026-11-28, the canvas design the
// owner approved). Pure helpers over lib/hours/grid's week grid, so the
// screen draws only the open hours (a closed hour's bare takings sat in the
// same grid as an open hour's net and read as the same thing), names the
// hours that lose money, and says what came in while the business was
// closed. Nothing is worked out differently: these read the grid and the
// analysis as they are. Tested in hours-view.test.ts.

import type { Weekday } from "../../lib/hours/schedule";
import type { WeekdayAnalysis } from "../../lib/hours/trading";
import type { GridRow, WeekGrid } from "../../lib/hours/grid";

const ORDER: Weekday[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

/**
 * A row the plain grid draws: a weekday with an open hour, or one whose hours
 * aren't stated (the analysis says so as "hours_unknown"; a weekday it left
 * out with no open hour is closed).
 */
const drawn = (r: GridRow) => r.cells.some((c) => c.open) || r.verdict === "hours_unknown";

/**
 * The grid cut to the hours the business is open: the columns where any day
 * is open, the rows with an open hour (or no stated hours), and the weekdays
 * it is closed all day, said once in words instead.
 */
export function openOnly(grid: WeekGrid): {
  hours: number[];
  rows: GridRow[];
  closedDays: Weekday[];
} {
  const hours = grid.hours.filter((h) =>
    grid.rows.some((r) => r.cells.some((c) => c.hour === h && c.open)),
  );
  const keep = new Set(hours);
  const rows = grid.rows
    .filter(drawn)
    .map((r) => ({ ...r, cells: r.cells.filter((c) => keep.has(c.hour)) }));
  const closedDays = grid.rows.filter((r) => !drawn(r)).map((r) => r.weekday);
  return { hours, rows, closedDays };
}

/** The open hours that lose money on judged days, the worst first. */
export function losingHours(
  grid: WeekGrid,
): { weekday: Weekday; hour: number; short_minor: number }[] {
  return grid.rows
    .filter((r) => r.verdict === "ok")
    .flatMap((r) =>
      r.cells
        .filter((c) => c.open && c.net_minor !== null && c.net_minor < 0)
        .map((c) => ({ weekday: r.weekday, hour: c.hour, short_minor: -(c.net_minor ?? 0) })),
    )
    .sort(
      (a, b) =>
        b.short_minor - a.short_minor || ORDER.indexOf(a.weekday) - ORDER.indexOf(b.weekday),
    );
}

/** How much of the best hour the first open hour already takes, as shares (0–1), on the days the opening signal fired. */
export function firstHourShares(weekdays: readonly WeekdayAnalysis[]): {
  days: Weekday[];
  low: number;
  high: number;
} | null {
  const shares = ORDER.flatMap((d) => {
    const w = weekdays.find((x) => x.weekday === d && x.verdict === "ok" && x.opening_signal);
    if (!w || w.first_hour === null || !w.peak || w.peak.mean_minor <= 0) return [];
    const first = w.curve.find((c) => c.hour === w.first_hour)?.mean_minor ?? 0;
    return [{ day: d, share: Math.min(1, first / w.peak.mean_minor) }];
  });
  if (shares.length === 0) return null;
  const values = shares.map((s) => s.share);
  return { days: shares.map((s) => s.day), low: Math.min(...values), high: Math.max(...values) };
}

/**
 * What came in while the business was closed: the total over the window, and
 * the closed weekday that took most on an average day (if any day is closed
 * all day), for "about €1,900 every Monday".
 */
export function takenWhileClosed(weekdays: readonly WeekdayAnalysis[]): {
  total_minor: number;
  perDay: { weekday: Weekday; minor: number } | null;
} {
  const total = weekdays.reduce((s, w) => s + Math.max(0, w.outside_hours_minor), 0);
  const closed = weekdays
    .filter((w) => w.verdict === "closed" && w.days_measured > 0 && w.outside_hours_minor > 0)
    .map((w) => ({
      weekday: w.weekday,
      minor: Math.round(w.outside_hours_minor / w.days_measured),
    }))
    .sort((a, b) => b.minor - a.minor);
  return { total_minor: total, perDay: closed[0] ?? null };
}
