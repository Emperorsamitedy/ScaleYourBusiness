// How Home's reads behave (docs/DASHBOARD-OVERHAUL.md C1) — pure, so the
// policy is pinned by tests and the hook beside it (useRead.ts) only does
// the fetching.
//
//   on return     what was read last shows at once, and a newer read goes
//                 out behind it ("refreshing")
//   while open    a read repeats on its interval and when the window
//                 regains focus, at most once in ten seconds, and never
//                 while the read before it is still out
//   on failure    with something already read, that stays on screen and is
//                 marked "lapsed"; with nothing, the card says it could not
//                 read and offers Retry ("failed")
//   on a refusal  401 is not a failure: the sign-in is gone, and nothing
//                 read before is shown again

import type { Read } from "./home-model";

/** What one fetch came back as, before it is folded into the state. */
export type Outcome<T> = { kind: "read"; data: T } | { kind: "signed_out" } | { kind: "failed" };

/** A cached read older than this is not shown again; the card starts from "Reading…". */
export const KEEP_MS = 10 * 60_000;
/** The least time between two reads set off by the window regaining focus. */
export const FOCUS_GAP_MS = 10_000;

/** Pure: the state a card opens in, from what the cache holds for its address. */
export function seeded<T>(cached: T | undefined): Read<T> {
  return cached === undefined
    ? { state: "reading" }
    : { state: "read", data: cached, refreshing: true };
}

/** Pure: the state while a new read is out. What was read stays; a failed card reads again. */
export function starting<T>(prev: Read<T>): Read<T> {
  if (prev.state === "read") return { ...prev, refreshing: true };
  if (prev.state === "failed") return { state: "reading" };
  return prev;
}

/** Pure: the state once a read has come back. */
export function settled<T>(prev: Read<T>, outcome: Outcome<T>): Read<T> {
  if (outcome.kind === "read") return { state: "read", data: outcome.data };
  if (outcome.kind === "signed_out") return { state: "signed_out" };
  // A failed refresh never empties a card that had something to show.
  return prev.state === "read"
    ? { state: "read", data: prev.data, lapsed: true }
    : { state: "failed" };
}

/** Pure: whether a cached read may still be shown at once. */
export function keepable(at: number, now: number, keep: number = KEEP_MS): boolean {
  return now - at >= 0 && now - at <= keep;
}

/** Pure: whether the window regaining focus should set off a read. */
export function focusDue(lastAt: number | null, now: number, gap: number = FOCUS_GAP_MS): boolean {
  return lastAt === null || now - lastAt >= gap;
}

/** A read still out after this long is given up on: the next tick reads again. */
export const OUT_MS = 120_000;

/**
 * Pure: whether a tick (the interval, the window's focus) may set off a
 * read. A read that is still out is waited for: a newer one would drop its
 * answer, and on a slow line no answer would ever land. Past OUT_MS it is
 * given up on. A read asked for by name (Retry, after an answer) does not
 * come through here: it always goes out.
 */
export function tickDue(outSince: number | null, now: number, limit: number = OUT_MS): boolean {
  return outSince === null || now - outSince >= limit;
}
