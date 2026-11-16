import { beforeEach, describe, expect, it } from "vitest";
import type { LiveDeps } from "./visitors";
import { LIVE_CACHE_MS, clearLiveCache, liveVisitors } from "./visitors";

const minutes = [
  { minutes_ago: 1, active: 4 },
  { minutes_ago: 0, active: 6 },
];

function deps(over: Partial<LiveDeps> = {}): LiveDeps & { reads: number } {
  const d = {
    reads: 0,
    now: () => 1_000_000,
    connection: async () => ({ status: "connected", encrypted_secret: "blob" }),
    decrypt: (blob: string) => `secret:${blob}`,
    read: async (secret: string) => {
      d.reads += 1;
      expect(secret).toBe("secret:blob");
      return minutes;
    },
    ...over,
  };
  return d;
}

beforeEach(() => clearLiveCache());

describe("liveVisitors", () => {
  it("reads the business's own Google Analytics connection and stamps the read", async () => {
    expect(await liveVisitors("acc-1", deps())).toEqual({
      status: "live",
      read_at: new Date(1_000_000).toISOString(),
      minutes,
    });
  });

  it("says there is nothing to read without a connection, or while it is paused", async () => {
    expect(await liveVisitors("acc-1", deps({ connection: async () => null }))).toEqual({
      status: "not_connected",
    });
    clearLiveCache();
    const paused = deps({
      connection: async () => ({ status: "paused", encrypted_secret: "blob" }),
    });
    expect(await liveVisitors("acc-1", paused)).toEqual({ status: "paused" });
    expect(paused.reads).toBe(0);
  });

  it("reports a failed read as unavailable, never as zero people", async () => {
    const failing = deps({
      read: async () => {
        throw new Error("google said no");
      },
    });
    expect(await liveVisitors("acc-1", failing)).toEqual({ status: "unavailable" });
  });

  it("asks Google at most once per business inside the cache window", async () => {
    let now = 1_000_000;
    const d = deps({ now: () => now });
    await liveVisitors("acc-1", d);
    now += LIVE_CACHE_MS - 1;
    await liveVisitors("acc-1", d);
    expect(d.reads).toBe(1);
    await liveVisitors("acc-2", d);
    expect(d.reads).toBe(2);
    now += 1;
    await liveVisitors("acc-1", d);
    expect(d.reads).toBe(3);
  });
});
