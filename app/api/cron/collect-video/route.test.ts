// P6-03 (2026-11-09): the background collector's cron. Only Vercel's
// bearer reaches it; it runs one collecting pass for every business and
// reports the pass's counts; a pass that throws is a failed job.

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const collect = vi.fn();

vi.mock("../../../../lib/content/candidates", () => ({
  collectCandidates: (...args: unknown[]) => collect(...args),
}));

const call = async (auth = "Bearer test-secret") => {
  const { GET } = await import("./route");
  return GET(
    new NextRequest("http://localhost/api/cron/collect-video", {
      headers: { authorization: auth },
    }),
  );
};

describe("GET /api/cron/collect-video", () => {
  beforeEach(() => {
    process.env.CRON_SECRET = "test-secret";
    collect.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("answers nobody without the cron secret, and collects nothing", async () => {
    const res = await call("Bearer wrong");
    expect(res.status).toBe(404);
    expect(collect).not.toHaveBeenCalled();
  });

  it("runs one pass for every business and reports it", async () => {
    const pass = {
      taken: 3,
      checked: 1,
      ready: 1,
      failed: 0,
      swept: 1,
      retried: 0,
      waiting: 0,
      sets_settled: 1,
      left: 0,
    };
    collect.mockResolvedValue(pass);
    const res = await call();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(pass);
    expect(collect).toHaveBeenCalledTimes(1);
    expect(collect.mock.calls[0]).toEqual([]);
  });

  it("a pass that throws is a failed job", async () => {
    collect.mockRejectedValue(new Error("db down"));
    const res = await call();
    expect(res.status).toBe(500);
  });
});
