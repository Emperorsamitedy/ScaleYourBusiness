// Axis ticks at round numbers — pure, so the charts' scales are tested
// without a browser. The ticks always cover [lo, hi]: the first is at or
// under the lowest value and the last at or over the highest.

const STEPS = [1, 2, 2.5, 5, 10] as const;

/** About `target` intervals between round numbers that cover lo..hi. */
export function niceTicks(lo: number, hi: number, target = 4): number[] {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [];
  if (hi < lo) return niceTicks(hi, lo, target);
  if (hi === lo) return lo === 0 ? [0, 1] : niceTicks(Math.min(0, lo), Math.max(0, lo), target);
  const raw = (hi - lo) / Math.max(1, target);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = (STEPS.find((s) => s * mag >= raw) ?? 10) * mag;
  const first = Math.floor(lo / step);
  const last = Math.ceil(hi / step);
  const ticks: number[] = [];
  for (let i = first; i <= last; i++) ticks.push(Number((i * step).toPrecision(12)));
  return ticks;
}
