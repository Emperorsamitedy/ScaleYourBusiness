// The site health rule (P3-33) on its own, pure: what counts as a load
// regression after a site change. lib/site/apply.ts applies it; the
// Decisions screen draws it (components/proposals/QueueCharts.tsx), so the
// limit an owner sees is the limit the engine uses.

/** P3-33's thresholds — code, with boundary tests, both directions. */
export const HEALTH = {
  /** A post-change load beyond baseline × this is a regression… */
  load_factor: 3,
  /** …but never for less than this absolute headroom, so a 40ms page
   * isn't "regressed" at 121ms. */
  load_floor_ms: 2000,
  /** A page smaller than this came back effectively empty. */
  min_bytes: 100,
} as const;

/** The two candidate limits and the one that applies: the larger. */
export function loadLimits(baselineMs: number): { times: number; plus: number; limit: number } {
  const times = baselineMs * HEALTH.load_factor;
  const plus = baselineMs + HEALTH.load_floor_ms;
  return { times, plus, limit: Math.max(times, plus) };
}

/** The load past which a changed page rolls back by itself. */
export function rollbackThresholdMs(baselineMs: number): number {
  return loadLimits(baselineMs).limit;
}
