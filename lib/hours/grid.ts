// The Trading hours screen's week grid (the owner's Trading hours design,
// 2026-10-17) — pure and client-safe: it imports types only, so the
// screen can lay out what /api/hours returns without pulling the
// analysis (and its database reads) into the browser.
//
// One row per weekday, one cell per trading hour any day is open. A cell
// is the hour's mean takings over that weekday's measured days (the
// analysis's curve — an hour with no sales is a zero, P2-27) minus what
// one open hour costs, when the owner has stated that cost. Bands:
//
//   loses   more than an eighth of the hour's cost below even
//   even    within an eighth of the cost either side
//   pays    more than an eighth above
//
// Without a stated cost there is no "pays": the cell shows takings only,
// and the screen says why. Revenue, not margin — the connectors measure
// takings, and the screen's label says so.

import type { OpeningSchedule, Weekday } from "./schedule";
import type { WeekdayAnalysis } from "./trading";

export const GRID_WEEKDAYS: readonly Weekday[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

/** The share of the hour's cost either side of even that still reads "about even". */
export const EVEN_SHARE = 0.125;

export type Band = "loses" | "even" | "pays";

export interface GridCell {
  hour: number;
  open: boolean;
  /** Mean takings in the hour, minor units; null when the day isn't measured for it. */
  takings_minor: number | null;
  /** Takings minus the hour's cost; null without a stated cost. */
  net_minor: number | null;
  band: Band | null;
}

export interface GridRow {
  weekday: Weekday;
  verdict: WeekdayAnalysis["verdict"] | "missing";
  days_measured: number;
  cells: GridCell[];
}

export interface WeekGrid {
  hours: number[];
  rows: GridRow[];
  /** Open hours in a week, over the weekdays whose hours are stated. */
  open_hours: number;
  /** Open hours whose takings fall short of the hour's cost, on judged weekdays. */
  losing_hours: number;
  /** ±this many minor units reads "about even". */
  even_within_minor: number | null;
}

function minutesOf(hhmm: string): number {
  const [h = "0", m = "0"] = hhmm.split(":");
  return Number(h) * 60 + Number(m);
}

/** Pure: whether trading hour `hour` (24 = 00:00 after midnight) overlaps an open period. */
export function isOpenHour(periods: readonly { open: string; close: string }[], hour: number) {
  return periods.some((p) => {
    const open = minutesOf(p.open);
    let close = minutesOf(p.close);
    if (close <= open) close += 24 * 60;
    return hour * 60 < close && (hour + 1) * 60 > open;
  });
}

export function bandOf(net: number, evenWithin: number): Band {
  if (net < -evenWithin) return "loses";
  if (net > evenWithin) return "pays";
  return "even";
}

/** Pure: the week grid from the schedule, the analysis and the stated hour cost. */
export function weekGrid(args: {
  schedule: Pick<OpeningSchedule, "days" | "unstated"> | null;
  weekdays: readonly WeekdayAnalysis[];
  hourCostMinor: number | null;
}): WeekGrid {
  const { schedule, weekdays, hourCostMinor } = args;
  const byDay = new Map(weekdays.map((w) => [w.weekday, w]));
  const periodsOf = (d: Weekday) =>
    schedule && !schedule.unstated.includes(d) ? (schedule.days[d] ?? []) : null;

  // Columns: every hour any stated day is open, plus any hour that took money.
  const hourSet = new Set<number>();
  for (const d of GRID_WEEKDAYS) {
    const periods = periodsOf(d);
    for (let h = 0; h < 30; h++) if (periods && isOpenHour(periods, h)) hourSet.add(h);
    for (const c of byDay.get(d)?.curve ?? []) if (c.mean_minor !== 0) hourSet.add(c.hour);
  }
  const lo = Math.min(...hourSet);
  const hi = Math.max(...hourSet);
  const hours = hourSet.size === 0 ? [] : Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);

  const evenWithin = hourCostMinor === null ? null : Math.round(hourCostMinor * EVEN_SHARE);
  let openHours = 0;
  let losing = 0;
  const rows: GridRow[] = GRID_WEEKDAYS.map((weekday) => {
    const w = byDay.get(weekday);
    const periods = periodsOf(weekday);
    const verdict = w?.verdict ?? "missing";
    const measured = w !== undefined && w.days_measured > 0 && verdict !== "hours_unknown";
    const cells = hours.map((hour): GridCell => {
      const open = periods !== null && isOpenHour(periods, hour);
      if (open) openHours += 1;
      const takings = measured ? (w.curve.find((c) => c.hour === hour)?.mean_minor ?? 0) : null;
      const net =
        takings !== null && hourCostMinor !== null && open ? takings - hourCostMinor : null;
      const band = net !== null && evenWithin !== null ? bandOf(net, evenWithin) : null;
      if (verdict === "ok" && net !== null && net < 0) losing += 1;
      return { hour, open, takings_minor: takings, net_minor: net, band };
    });
    return { weekday, verdict, days_measured: w?.days_measured ?? 0, cells };
  });

  return {
    hours,
    rows,
    open_hours: openHours,
    losing_hours: losing,
    even_within_minor: evenWithin,
  };
}

/** "20", "00" — the column head, on the 24-hour clock. */
export function hourHead(hour: number): string {
  return String(hour % 24).padStart(2, "0");
}

/** The best-paying open cell(s): the weekdays sharing the highest net hour. */
export function bestHour(
  grid: WeekGrid,
): { weekdays: Weekday[]; hour: number; net_minor: number } | null {
  let best: { weekdays: Weekday[]; hour: number; net_minor: number } | null = null;
  for (const row of grid.rows) {
    if (row.verdict !== "ok") continue;
    for (const c of row.cells) {
      if (!c.open || c.net_minor === null) continue;
      if (best === null || c.net_minor > best.net_minor) {
        best = { weekdays: [row.weekday], hour: c.hour, net_minor: c.net_minor };
      } else if (c.net_minor === best.net_minor && c.hour === best.hour) {
        best.weekdays.push(row.weekday);
      }
    }
  }
  return best !== null && best.net_minor > 0 ? best : null;
}
