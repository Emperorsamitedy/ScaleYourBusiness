// Insights · Goals, said plainly (2026-11-28, the canvas design the owner
// approved). Pure helpers: where a goal stands against its target before the
// weekly check may judge it, and where "now" and the path sit on the bar from
// the starting point to the target. Nothing is judged here: the verdict stays
// the weekly check's (lib/care/progress); this only says what the figures
// already show. Tested in goal-view.test.ts.

/** Past the target already, by the goal's own direction (a "lower" goal is past it when at or under). */
export function pastTarget(
  now: number | null,
  target: number,
  direction: "increase" | "decrease",
): boolean | null {
  if (now === null) return null;
  return direction === "increase" ? now >= target : now <= target;
}

/**
 * Where now and the path sit on the bar from the start (0) to the target (1).
 * Now is clamped to the bar and flagged when it ran past the target; the
 * path is clamped and null without one. Null without a start, or when the
 * start already equals the target (no distance to draw).
 */
export function barShares(args: {
  start: number | null;
  target: number;
  now: number | null;
  path: number | null;
}): { now: number; past: boolean; path: number | null } | null {
  const { start, target, now, path } = args;
  if (start === null || now === null || start === target) return null;
  const at = (v: number) => (v - start) / (target - start);
  const share = at(now);
  const clamp = (v: number) => Math.max(0, Math.min(1, v));
  return { now: clamp(share), past: share >= 1, path: path === null ? null : clamp(at(path)) };
}
