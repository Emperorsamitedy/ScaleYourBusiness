// Security review 2026-11-09: a race-safe, multi-instance-safe rate limiter.
// Against the real database — the one thing worth proving here is that the
// ON CONFLICT upsert actually serialises concurrent increments correctly,
// which a mocked db can't demonstrate.

import "dotenv/config";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "../../db";
import { rateLimits } from "../../db/schema";
import { withinRateLimit } from "./rate-limit";

// An hour-wide window: the test finishes in well under a second, so a real
// window boundary (aligned to the epoch) landing mid-test is effectively
// impossible — unlike a minute-wide window, which did land on one once.
const WINDOW_MS = 3_600_000;

const keysUsed: string[] = [];
function freshIdentity(): string {
  const id = `test:${randomUUID()}`;
  keysUsed.push(id);
  return id;
}

afterAll(async () => {
  for (const id of keysUsed) {
    await db.delete(rateLimits).where(eq(rateLimits.key, `${id}:${WINDOW_MS}`));
  }
});

describe("withinRateLimit", () => {
  it("allows calls up to the limit, then refuses", async () => {
    const id = freshIdentity();
    expect(await withinRateLimit(id, 3, WINDOW_MS)).toBe(true); // 1
    expect(await withinRateLimit(id, 3, WINDOW_MS)).toBe(true); // 2
    expect(await withinRateLimit(id, 3, WINDOW_MS)).toBe(true); // 3
    expect(await withinRateLimit(id, 3, WINDOW_MS)).toBe(false); // 4 — over
    expect(await withinRateLimit(id, 3, WINDOW_MS)).toBe(false); // 5 — still over
  });

  it("keeps separate identities independent", async () => {
    const a = freshIdentity();
    const b = freshIdentity();
    expect(await withinRateLimit(a, 1, WINDOW_MS)).toBe(true);
    expect(await withinRateLimit(a, 1, WINDOW_MS)).toBe(false);
    // b has never been called — its own counter starts fresh.
    expect(await withinRateLimit(b, 1, WINDOW_MS)).toBe(true);
  });

  it("counts correctly under concurrent calls — the atomic upsert, not a read-then-write race", async () => {
    const id = freshIdentity();
    const results = await Promise.all(
      Array.from({ length: 10 }, () => withinRateLimit(id, 5, WINDOW_MS)),
    );
    expect(results.filter(Boolean).length).toBe(5);
    expect(results.filter((r) => !r).length).toBe(5);
  });
});
