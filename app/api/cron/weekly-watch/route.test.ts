// Review 2026-10-30: one step of the weekly beat that throws (forecast
// grading, the review or cart prune) is logged, and the steps after it,
// the owner's weekly summary above all, still run.

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const grading = vi.fn();
const reviewsPrune = vi.fn();
const cartsPrune = vi.fn();
const summaries = vi.fn();
const warningSweep = vi.fn();

vi.mock("../../../../lib/watch/job", () => ({ runWeeklyWatch: async () => ({ profiles: 1 }) }));
vi.mock("../../../../lib/care/progress", () => ({ runProgressChecks: async () => ({}) }));
vi.mock("../../../../lib/hours/trials", () => ({ runHoursTrials: async () => ({}) }));
vi.mock("../../../../lib/ads/proposals", () => ({ runAdProposals: async () => ({}) }));
vi.mock("../../../../lib/stock/warnings", () => ({ runStockWarnings: async () => ({}) }));
vi.mock("../../../../lib/stock/propose", () => ({ runStockProposals: async () => ({}) }));
vi.mock("../../../../lib/content/season-push", () => ({ runSeasonPushes: async () => ({}) }));
vi.mock("../../../../lib/forecasts/run", () => ({ runForecastGrading: () => grading() }));
vi.mock("../../../../lib/reviews/store", () => ({ pruneExpiredReviews: () => reviewsPrune() }));
vi.mock("../../../../lib/carts/store", () => ({ pruneExpiredCarts: () => cartsPrune() }));
vi.mock("../../../../lib/summary/run", () => ({ runWeeklySummaries: () => summaries() }));
vi.mock("../../../../lib/warnings/sweep", () => ({
  raiseDueWarningAlerts: () => warningSweep(),
}));
vi.mock("../../../../lib/billing/guarantee-run", () => ({
  runGuaranteeQuarter: async () => ({ evaluated: 0, credits: 0, rolled_forward: 0 }),
}));
vi.mock("../../../../lib/billing/stripe", () => ({ paymentsConfigured: () => false }));
vi.mock("../../../../lib/billing/subscribe", () => ({
  runDormantCheck: async () => ({ checked: 0, paused: 0 }),
}));
vi.mock("../../../../lib/diagnosis/monthly", () => ({
  runMonthlyRediagnosis: async () => ({
    checked: 2,
    regenerated: 1,
    unchanged: 1,
    failed: 0,
    deferred: 0,
  }),
}));

const call = async () => {
  const { GET } = await import("./route");
  return GET(
    new NextRequest("http://localhost/api/cron/weekly-watch", {
      headers: { authorization: "Bearer test-secret" },
    }),
  );
};

describe("GET /api/cron/weekly-watch", () => {
  beforeEach(() => {
    process.env.CRON_SECRET = "test-secret";
    for (const f of [grading, reviewsPrune, cartsPrune, summaries, warningSweep]) f.mockReset();
    warningSweep.mockResolvedValue({ looked: 0, news: 0, alerts: 0, emails: 0, failed: 0 });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("a failing step is logged and reported as null; the summaries still go", async () => {
    grading.mockRejectedValue(new Error("grading broke"));
    reviewsPrune.mockRejectedValue(new Error("prune broke"));
    cartsPrune.mockResolvedValue(3);
    summaries.mockResolvedValue({ sent: 2 });
    const res = await call();
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      forecasts: null,
      reviews_expired: null,
      carts_expired: 3,
      rediagnosis: { checked: 2, regenerated: 1 },
      summaries: { sent: 2 },
    });
    expect(summaries).toHaveBeenCalledOnce();
    const logged = vi.mocked(console.error).mock.calls.map((c) => String(c[0]));
    expect(logged.some((l) => l.includes('"step":"forecast_grading"'))).toBe(true);
    expect(logged.some((l) => l.includes('"step":"reviews_prune"'))).toBe(true);
  });

  it("with every step well, every result is reported", async () => {
    grading.mockResolvedValue({ due: 0, graded: 0, waiting: 0, failed: 0 });
    reviewsPrune.mockResolvedValue(1);
    cartsPrune.mockResolvedValue(0);
    summaries.mockResolvedValue({ sent: 1 });
    const body = (await (await call()).json()) as Record<string, unknown>;
    expect(body).toMatchObject({ reviews_expired: 1, carts_expired: 0, forecasts: { due: 0 } });
  });

  it("raises the warnings' alerts after the summaries have gone, never before", async () => {
    grading.mockResolvedValue({ due: 0, graded: 0, waiting: 0, failed: 0 });
    reviewsPrune.mockResolvedValue(0);
    cartsPrune.mockResolvedValue(0);
    const order: string[] = [];
    summaries.mockImplementation(async () => {
      order.push("summaries");
      return { sent: 1 };
    });
    warningSweep.mockImplementation(async () => {
      order.push("alerts");
      return { looked: 2, news: 1, alerts: 1, emails: 0, failed: 0 };
    });
    const body = (await (await call()).json()) as Record<string, unknown>;
    expect(order).toEqual(["summaries", "alerts"]);
    expect(body).toMatchObject({ warning_alerts: { news: 1, alerts: 1, emails: 0 } });
  });

  it("a sweep that throws is logged and reported as null; the beat still answers", async () => {
    grading.mockResolvedValue({ due: 0, graded: 0, waiting: 0, failed: 0 });
    reviewsPrune.mockResolvedValue(0);
    cartsPrune.mockResolvedValue(0);
    summaries.mockResolvedValue({ sent: 1 });
    warningSweep.mockRejectedValue(new Error("sweep broke"));
    const res = await call();
    expect(res.status).toBe(200);
    expect((await res.json()) as Record<string, unknown>).toMatchObject({
      summaries: { sent: 1 },
      warning_alerts: null,
    });
    const logged = vi.mocked(console.error).mock.calls.map((c) => String(c[0]));
    expect(logged.some((l) => l.includes('"step":"warning_alerts"'))).toBe(true);
  });

  it("refuses without the cron secret", async () => {
    const { GET } = await import("./route");
    const res = await GET(new NextRequest("http://localhost/api/cron/weekly-watch"));
    expect(res.status).toBe(404);
    expect(summaries).not.toHaveBeenCalled();
    expect(warningSweep).not.toHaveBeenCalled();
  });
});
