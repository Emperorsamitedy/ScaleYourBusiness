// The nightly FAQ run keeps going when one business fails — an API error or
// the model declining — so the businesses after it still get clustered.

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const rows = [
  { profile_id: "p-1", account_id: "a-1" },
  { profile_id: "p-2", account_id: "a-2" },
];

vi.mock("../../../../db", () => ({
  db: { select: () => ({ from: () => Promise.resolve(rows) }) },
}));

const clusterQuestions = vi.fn();
vi.mock("../../../../lib/crm/faq", () => ({
  clusterQuestions: (...args: unknown[]) => clusterQuestions(...args),
}));

describe("GET /api/cron/faq-cluster", () => {
  beforeEach(() => {
    process.env.CRON_SECRET = "test-secret";
    clusterQuestions.mockReset();
  });

  it("logs a business that fails and still clusters the next one", async () => {
    clusterQuestions
      .mockRejectedValueOnce(new Error("the model declined"))
      .mockResolvedValueOnce({ proposal_id: "prop-2", unanswered: [], cost_eur: 0.0002 });
    const { GET } = await import("./route");
    const res = await GET(
      new NextRequest("http://localhost/api/cron/faq-cluster", {
        headers: { authorization: "Bearer test-secret" },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { failed: number; proposed: number; businesses: number };
    expect(body).toMatchObject({ businesses: 2, failed: 1, proposed: 1 });
    expect(clusterQuestions).toHaveBeenCalledTimes(2);
  });

  it("refuses without the cron secret", async () => {
    const { GET } = await import("./route");
    const res = await GET(new NextRequest("http://localhost/api/cron/faq-cluster"));
    expect(res.status).toBe(404);
    expect(clusterQuestions).not.toHaveBeenCalled();
  });
});
