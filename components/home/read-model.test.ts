import { describe, expect, it } from "vitest";
import type { Read } from "./home-model";
import { dataOf, signedOut, waitingCount } from "./home-model";
import {
  FOCUS_GAP_MS,
  KEEP_MS,
  OUT_MS,
  focusDue,
  keepable,
  seeded,
  settled,
  starting,
  tickDue,
} from "./read-model";

// docs/DASHBOARD-OVERHAUL.md C1: reads that cache, repeat and retry.
describe("Home's reads: what shows while a read is out", () => {
  it("opens on what was read last, marked as refreshing, and on Reading with nothing kept", () => {
    expect(seeded({ pending: 2 })).toEqual({
      state: "read",
      data: { pending: 2 },
      refreshing: true,
    });
    expect(seeded(undefined)).toEqual({ state: "reading" });
  });

  it("keeps what was read on screen while the next read is out, and reads a failed card again", () => {
    const read: Read<number> = { state: "read", data: 3 };
    expect(starting(read)).toEqual({ state: "read", data: 3, refreshing: true });
    expect(starting<number>({ state: "failed" })).toEqual({ state: "reading" });
    expect(starting<number>({ state: "reading" })).toEqual({ state: "reading" });
  });
});

describe("Home's reads: what a read coming back does", () => {
  it("replaces the data and clears the marks on a good read", () => {
    const prev: Read<number> = { state: "read", data: 3, refreshing: true, lapsed: true };
    expect(settled(prev, { kind: "read", data: 4 })).toEqual({ state: "read", data: 4 });
  });

  it("never empties a card on a failed refresh: the last read stays, marked lapsed", () => {
    const prev: Read<number> = { state: "read", data: 3, refreshing: true };
    const next = settled(prev, { kind: "failed" });
    expect(next).toEqual({ state: "read", data: 3, lapsed: true });
    // The rest of Home still counts from it.
    expect(dataOf(next)).toBe(3);
  });

  it("says failed only when there was nothing to show, which is never an answer", () => {
    const next = settled<{ pending: number }>({ state: "reading" }, { kind: "failed" });
    expect(next).toEqual({ state: "failed" });
    // A failed count is "unread", never "nothing to decide".
    expect(waitingCount(next, { state: "failed" })).toEqual({ state: "unread" });
  });

  it("treats a refusal as the sign-in gone, whatever was on screen", () => {
    const prev: Read<number> = { state: "read", data: 3 };
    const next = settled(prev, { kind: "signed_out" });
    expect(next).toEqual({ state: "signed_out" });
    expect(signedOut([next])).toBe(true);
    expect(dataOf(next)).toBeNull();
  });
});

describe("Home's reads: when to read again", () => {
  it("shows a cached read at once only while it is recent", () => {
    expect(keepable(1_000, 1_000 + KEEP_MS)).toBe(true);
    expect(keepable(1_000, 1_001 + KEEP_MS)).toBe(false);
    expect(keepable(2_000, 1_000)).toBe(false); // a clock that went backwards keeps nothing
  });

  it("reads on focus at most once in ten seconds", () => {
    expect(focusDue(null, 5_000)).toBe(true);
    expect(focusDue(5_000, 5_000 + FOCUS_GAP_MS - 1)).toBe(false);
    expect(focusDue(5_000, 5_000 + FOCUS_GAP_MS)).toBe(true);
  });

  it("waits on a tick for a read that is still out, and gives up on it after two minutes", () => {
    // Nothing out: the interval reads.
    expect(tickDue(null, 30_000)).toBe(true);
    // A slow answer (longer than the interval) is waited for, not dropped for a newer question.
    expect(tickDue(1_000, 31_000)).toBe(false);
    expect(tickDue(1_000, 1_000 + OUT_MS - 1)).toBe(false);
    // One that never comes back does not stop the reads for good.
    expect(tickDue(1_000, 1_000 + OUT_MS)).toBe(true);
  });
});
