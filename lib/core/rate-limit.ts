// A fixed-window rate limiter backed by Postgres (db/schema.ts rateLimits) —
// security review 2026-11-09. No in-memory counter: Vercel runs several
// serverless instances, so a per-process counter would undercount across
// cold starts and instances. One atomic upsert per call; Postgres's own
// ON CONFLICT guarantees the increment can't race under concurrent requests.
//
// The window is fixed (aligned to epoch), not sliding: a caller right at a
// window boundary could in principle get up to 2x the limit across the
// boundary. That is an accepted simplicity trade-off for an abuse guard —
// it does not need to be a precise quota, only cheap, race-safe, and hard
// to talk your way past.

import { sql } from "drizzle-orm";
import { db } from "../../db";
import { rateLimits } from "../../db/schema";

/**
 * Records one call under `identity` (already scoped by the caller, e.g.
 * "login:email:a@b.com") and reports whether it is within `limit` calls per
 * `windowMs`. True = allowed (this call counted), false = over the limit
 * (this call still counted, so a caller spamming past the limit doesn't
 * reset or escape it).
 */
export async function withinRateLimit(
  identity: string,
  limit: number,
  windowMs: number,
): Promise<boolean> {
  const windowStart = Math.floor(Date.now() / windowMs) * windowMs;
  // windowMs folded into the key: the same identity rate-limited at two
  // different window sizes (e.g. a short burst cap and a daily cap) gets
  // two independent counters rather than one colliding row.
  const key = `${identity}:${windowMs}`;
  const [row] = await db
    .insert(rateLimits)
    .values({ key, window_start: windowStart, count: 1 })
    .onConflictDoUpdate({
      target: rateLimits.key,
      set: {
        count: sql`case when ${rateLimits.window_start} = excluded.window_start
          then ${rateLimits.count} + 1 else 1 end`,
        window_start: sql`excluded.window_start`,
      },
    })
    .returning({ count: rateLimits.count });
  return (row?.count ?? 0) <= limit;
}
