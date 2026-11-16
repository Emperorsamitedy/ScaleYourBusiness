// Home's live line, the arithmetic (specs/ux-spec-v1.md §2.1, "The live
// line"). Pure, so where each minute sits, which side of the baseline it is
// on and what the scale reads are tested without a browser.

import { niceTicks } from "../../lib/charts/ticks";

export interface MinuteReading {
  minutes_ago: number;
  active: number;
}

export interface LivePoint {
  /** When the minute's figure stands: the read time less its minutes ago, epoch ms. */
  at: number;
  value: number;
}

const MINUTE_MS = 60_000;

/** The readings as points in time, oldest first, keeping those inside the window ending now. */
export function livePoints(
  minutes: readonly MinuteReading[],
  readAt: number,
  now: number,
  windowMinutes: number,
): LivePoint[] {
  const from = now - windowMinutes * MINUTE_MS;
  return minutes
    .map((m) => ({ at: readAt - m.minutes_ago * MINUTE_MS, value: m.active }))
    .filter((p) => p.at >= from)
    .sort((a, b) => a.at - b.at);
}

export interface Scale {
  lo: number;
  hi: number;
  /** Whole people only: a count has no half-person tick. */
  ticks: number[];
}

/** A scale that frames the line with a little room above and below, never under zero. */
export function liveScale(values: readonly number[]): Scale {
  const top = Math.max(0, ...values);
  const bottom = Math.min(top, ...values);
  const span = Math.max(4, top - bottom);
  const lo = Math.max(0, bottom - span * 0.15);
  const hi = top + span * 0.15;
  return {
    lo,
    hi,
    ticks: niceTicks(lo, hi).filter((t) => Number.isInteger(t) && t >= lo && t <= hi),
  };
}

export interface XY {
  x: number;
  y: number;
}

export interface Split {
  up: XY[][];
  down: XY[][];
}

/**
 * The line cut where it crosses the baseline `by` (screen y, so smaller is
 * higher): the runs above it are drawn as up, the runs below as down. A
 * crossing becomes a shared point exactly on the baseline.
 */
export function splitAtBaseline(points: readonly XY[], by: number): Split {
  const out: Split = { up: [], down: [] };
  let run: XY[] = [];
  let side: "up" | "down" | null = null;
  for (let i = 0; i < points.length; i++) {
    const p = points[i] as XY;
    const s = p.y <= by ? "up" : "down";
    if (side === null) {
      side = s;
      run = [p];
    } else if (s === side) {
      run.push(p);
    } else {
      const q = points[i - 1] as XY;
      const cross = { x: q.x + ((p.x - q.x) * (by - q.y)) / (p.y - q.y), y: by };
      run.push(cross);
      out[side].push(run);
      side = s;
      run = [cross, p];
    }
  }
  if (side !== null && run.length > 0) out[side].push(run);
  return out;
}

/** An SVG path through each run. */
export function pathOf(runs: readonly XY[][]): string {
  return runs
    .map((r) => r.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(""))
    .join("");
}

/** Each run closed down (or up) to the baseline, for its fill. */
export function fillOf(runs: readonly XY[][], by: number): string {
  return runs
    .filter((r) => r.length > 1)
    .map((r) => {
      const first = r[0] as XY;
      const last = r[r.length - 1] as XY;
      return `${pathOf([r])}L${last.x.toFixed(1)} ${by.toFixed(1)}L${first.x.toFixed(1)} ${by.toFixed(1)}Z`;
    })
    .join("");
}

/** The change from the window's first reading: the figure, and as a share of where it began. */
export function change(base: number, value: number): { diff: number; share: number | null } {
  return { diff: value - base, share: base > 0 ? (value - base) / base : null };
}
