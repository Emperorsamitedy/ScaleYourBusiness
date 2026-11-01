// I-45a: the Google reviews read rides the daily sync beat as its own step.
// A Google failure is logged and reported as null, and the measurement sync
// still reports; a failed sync still fails the job, after the reviews were read.

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sync = vi.fn();
const google = vi.fn();

vi.mock("../../../../lib/connectors/sync", () => ({ runConnectorSync: () => sync() }));
vi.mock("../../../../lib/google-business/read", () => ({ runGoogleReviewReads: () => google() }));

const call = async (auth = "Bearer test-secret") => {
  const { GET } = await import("./route");
  return GET(
    new NextRequest("http://localhost/api/cron/connector-sync", {
      headers: { authorization: auth },
    }),
  );
};

describe("GET /api/cron/connector-sync", () => {
  beforeEach(() => {
    process.env.CRON_SECRET = "test-secret";
    sync.mockReset();
    google.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("the beat survives a Google failure: the sync's result still reports", async () => {
    sync.mockResolvedValue({ connections: 2, synced: 2 });
    google.mockRejectedValue(new Error("google broke"));
    const res = await call();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ connections: 2, synced: 2, google_reviews: null });
    const logged = vi.mocked(console.error).mock.calls.map((c) => String(c[0]));
    expect(logged.some((l) => l.includes('"step":"google_reviews"'))).toBe(true);
  });

  it("with both well, both report", async () => {
    sync.mockResolvedValue({ connections: 1 });
    google.mockResolvedValue({
      configured: true,
      businesses: 1,
      ok: 1,
      failed: 0,
      filed: 2,
      alerted: 1,
    });
    const body = (await (await call()).json()) as Record<string, unknown>;
    expect(body).toMatchObject({ connections: 1, google_reviews: { filed: 2, alerted: 1 } });
  });

  it("a failed sync still fails the job, and the reviews were read anyway", async () => {
    sync.mockRejectedValue(new Error("sync broke"));
    google.mockResolvedValue({
      configured: false,
      businesses: 0,
      ok: 0,
      failed: 0,
      filed: 0,
      alerted: 0,
    });
    const res = await call();
    expect(res.status).toBe(500);
    expect(google).toHaveBeenCalledOnce();
  });

  it("refuses without the cron secret", async () => {
    const res = await call("Bearer nope");
    expect(res.status).toBe(404);
    expect(sync).not.toHaveBeenCalled();
    expect(google).not.toHaveBeenCalled();
  });
});
