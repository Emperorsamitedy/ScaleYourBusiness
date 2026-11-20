// Warnings sent at once: the morning look as a whole, against the database.
// Its three steps are tested where they live (the stock check in
// lib/stock/reorder.test.ts, the cash look in lib/cash/load.test.ts, the
// sweep in ./sweep.test.ts); here, that the beat runs them in turn, reports
// each, and that one of them failing does not stop the alerts.

import "dotenv/config";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../../db";
import { watchActivity } from "../../db/schema";
import type { EmailFetch } from "../auth/email";
import { fakePushService } from "../push/send";
import { business, cleanup, device } from "../push/test-fixtures";
import type * as StockWarnings from "../stock/warnings";

const stockRun = vi.hoisted(() => ({ fail: false }));
vi.mock("../stock/warnings", async (real) => {
  const actual = await real<typeof StockWarnings>();
  return {
    ...actual,
    runStockWarnings: (...args: Parameters<typeof actual.runStockWarnings>) => {
      if (stockRun.fail) throw new Error("the stock check broke");
      return actual.runStockWarnings(...args);
    },
  };
});

const NOW = new Date("2026-11-10T09:00:00Z"); // a Tuesday, 10:00 in Budapest
const MUG = "Speckled Everyday Mug runs out in about 3 to 4 days; Midland Clay takes 10 days.";

afterAll(cleanup);
beforeEach(() => {
  stockRun.fail = false;
  vi.stubEnv("RESEND_API_KEY", "re_test_key");
  vi.stubEnv("APP_URL", "https://app.example");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** A business with a phone, and a stock warning this morning's look has just written. */
async function morning() {
  const b = await business();
  await device(b);
  await db.insert(watchActivity).values({
    profile_id: b.profile_id,
    at: new Date(NOW.getTime() - 60_000).toISOString(),
    kind: "stock_warning",
    detail: MUG,
    meta: { signature: "sku:mug|tight|2026-W46", key: "sku:mug", level: "tight" },
  });
  const push = fakePushService();
  const sent: { subject: string; text: string }[] = [];
  const fetchImpl: EmailFetch = async (_url, init) => {
    sent.push(JSON.parse(String(init.body)) as (typeof sent)[number]);
    return new Response(JSON.stringify({ id: "email-1" }), { status: 200 });
  };
  return { b, push, sent, opts: { profileIds: [b.profile_id], push, fetchImpl } };
}

describe("the morning look", () => {
  it("checks stock and cash, then tells what is news", async () => {
    const { runDailyWarnings } = await import("./daily");
    const { push, sent, opts } = await morning();
    const out = await runDailyWarnings(NOW, opts);
    // No stock module and no watch on this business: both looks find nothing to write.
    expect(out.stock).toEqual({ logged: 0, failed: 0 });
    expect(out.cash).toEqual({ looked: 0, appeared: 0 });
    expect(out.alerts).toMatchObject({ looked: 1, news: 1, alerts: 1, emails: 1, failed: 0 });
    expect(push.sent).toHaveLength(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toContain(MUG);
  });

  it("still tells what is news when the stock check fails as a whole", async () => {
    const { runDailyWarnings } = await import("./daily");
    const { push, sent, opts } = await morning();
    stockRun.fail = true;
    const out = await runDailyWarnings(NOW, opts);
    expect(out.stock).toBeNull();
    expect(out.cash).toEqual({ looked: 0, appeared: 0 });
    expect(out.alerts).toMatchObject({ news: 1, alerts: 1, emails: 1 });
    expect(push.sent).toHaveLength(1);
    expect(sent).toHaveLength(1);
    const logged = vi.mocked(console.error).mock.calls.map((c) => String(c[0]));
    expect(logged.some((l) => l.includes('"step":"stock"'))).toBe(true);
  });
});
