// Comparing a caller's secret with ours — the security review of 2026-10-17.
//
// `given !== expected` returns as soon as a character differs, which leaks
// how much of a guess was right through timing. Both sides are hashed to a
// fixed length first, so the compare is constant-time and the lengths say
// nothing either. An unset or empty secret matches nothing, ever.

import { createHash, timingSafeEqual } from "node:crypto";

const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();

/** True only when a secret is configured and the caller's value equals it. */
export function secretMatches(
  given: string | null | undefined,
  expected: string | undefined,
): boolean {
  if (!expected || given === null || given === undefined) return false;
  return timingSafeEqual(digest(given), digest(expected));
}

/** The Bearer form the cron routes use: `Authorization: Bearer <secret>`. */
export function bearerMatches(authorization: string | null, expected: string | undefined): boolean {
  if (!expected || !authorization) return false;
  return secretMatches(authorization, `Bearer ${expected}`);
}
