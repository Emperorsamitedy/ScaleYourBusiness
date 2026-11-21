// Warnings sent at once: the morning beat's door. Only the cron's secret
// opens it; open, it runs the morning look once and reports what it found.

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const daily = vi.fn();

vi.mock("../../../../lib/warnings/daily", () => ({ runDailyWarnings: () => daily() }));

const call = async (headers: Record<string, string> = {}) => {
  const { GET } = await import("./route");
  return GET(new NextRequest("http://localhost/api/cron/daily-warnings", { headers }));
};

describe("GET /api/cron/daily-warnings", () => {
  beforeEach(() => {
    process.env.CRON_SECRET = "test-secret";
    daily.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("refuses without the cron secret, and with a wrong one", async () => {
    expect((await call()).status).toBe(404);
    expect((await call({ authorization: "Bearer not-it" })).status).toBe(404);
    expect(daily).not.toHaveBeenCalled();
  });

  it("runs the morning look once and reports it", async () => {
    const found = {
      stock: { logged: 1, failed: 0 },
      cash: { looked: 2, appeared: 0 },
      alerts: { looked: 1, news: 1, alerts: 1, emails: 1, failed: 0 },
    };
    daily.mockResolvedValue(found);
    const res = await call({ authorization: "Bearer test-secret" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(found);
    expect(daily).toHaveBeenCalledOnce();
  });

  it("says the job failed, with no detail, when the look throws", async () => {
    daily.mockRejectedValue(new Error("the database is away"));
    const res = await call({ authorization: "Bearer test-secret" });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "job failed" });
  });
});
