// I-45d against the database: a review alert's phone alert, planned and
// sent from the trusted side. The review's own row is the queue
// (alerted_at set, push_settled_at null); the flush sends it through the
// fake push service (no network) and settles it, once. Clocks are pinned
// to a Tuesday in November: Budapest is UTC+1.

import "dotenv/config";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "../../db";
import { reviews } from "../../db/schema";
import { claimReviewAlert } from "../reviews/alert";
import type { ScenarioBlock } from "../diagnosis/recommendations";
import { createProposal } from "../proposals/service";
import { flushHeldPushes, flushPushes } from "./flush";
import { fakePushService } from "./send";
import { business, cleanup, device } from "./test-fixtures";

const MORNING = new Date("2026-11-10T09:00:00Z"); // 10:00 in Budapest
const EVENING = new Date("2026-11-10T21:30:00Z"); // 22:30
const NEXT_MORNING = new Date("2026-11-11T07:05:00Z"); // 08:05

afterAll(cleanup);

/** A review filed and its one alert claimed, as the inbound path does. */
async function alerted(
  b: { account_id: string; profile_id: string },
  at: Date,
  over: { source?: "email" | "paste"; stars?: number } = {},
) {
  const [row] = await db
    .insert(reviews)
    .values({
      profile_id: b.profile_id,
      account_id: b.account_id,
      platform: "google",
      source: over.source ?? "email",
      read_by: over.source === "paste" ? "owner" : "parser",
      stars: over.stars ?? 2,
      reviewer: "Anna Kovács",
      text: "Cold soup and a rude waiter.",
      reviewed_at: at.toISOString(),
      received_at: at.toISOString(),
      dedupe_key: crypto.randomUUID(),
      worth_knowing: true,
      expires_at: new Date(at.getTime() + 365 * 86_400_000).toISOString(),
    })
    .returning();
  const claimed = await claimReviewAlert(
    {
      id: row!.id,
      account_id: b.account_id,
      profile_id: b.profile_id,
      platform: "google",
      stars: row!.stars,
      worth_knowing: true,
    },
    { now: at },
  );
  expect(claimed).toBe(true);
  return row!.id;
}

const settledAt = async (id: string) =>
  (await db.select().from(reviews).where(eq(reviews.id, id)))[0]?.push_settled_at ?? null;

const scenario: ScenarioBlock = {
  assumptions: [],
  base_case: { case: "base", statement: "t", profit_delta_monthly: null, formula: null },
  downside_case: { case: "downside", statement: "t", profit_delta_monthly: null, formula: null },
  upside_case: { case: "upside", statement: "t", profit_delta_monthly: null, formula: null },
  breakeven_condition: "none — test fixture",
};

describe("I-45d — a review alert reaches the phone", () => {
  it("goes as the platform and the stars, taps through to /reviews, and goes once", async () => {
    const b = await business();
    await device(b);
    const id = await alerted(b, new Date(MORNING.getTime() - 60_000));
    const fake = fakePushService();
    expect(await flushPushes(b.profile_id, { service: fake, now: MORNING })).toMatchObject({
      plan: "send",
      sent: 1,
    });
    expect(fake.sent[0]?.payload).toMatchObject({
      body: "A 2-star review on Google",
      url: "/reviews",
    });
    expect(JSON.stringify(fake.sent[0]?.payload)).not.toMatch(/Anna|Kovács|soup|rude/);
    expect(await settledAt(id)).not.toBeNull();
    // Settled: the next flush finds nothing.
    const again = fakePushService();
    expect(await flushPushes(b.profile_id, { service: again, now: MORNING })).toMatchObject({
      plan: "nothing",
    });
    expect(again.sent).toHaveLength(0);
  });

  it("waits through quiet hours, then the morning beat sends it", async () => {
    const b = await business();
    await device(b);
    const id = await alerted(b, new Date(EVENING.getTime() - 60_000));
    const fake = fakePushService();
    expect(await flushPushes(b.profile_id, { service: fake, now: EVENING })).toMatchObject({
      plan: "hold",
      why: "quiet_hours",
    });
    expect(fake.sent).toHaveLength(0);
    expect(await settledAt(id)).toBeNull();
    const beat = await flushHeldPushes({ service: fake, now: NEXT_MORNING });
    expect(beat.sent).toBeGreaterThanOrEqual(1);
    expect(fake.sent.map((s) => s.payload.url)).toContain("/reviews");
    expect(await settledAt(id)).not.toBeNull();
  });

  it("rides along with a proposal's alert: one alert for both", async () => {
    const b = await business();
    await device(b);
    await alerted(b, new Date(MORNING.getTime() - 60_000));
    await createProposal({
      profile_id: b.profile_id,
      module: "diagnosis",
      action: { kind: "price_increase", summary: "Raise the espresso" },
      scenario,
      reversibility: { level: "easy", if_you_change_your_mind: "change it back" },
      expires_at: "2027-01-31T00:00:00.000Z",
    });
    const fake = fakePushService();
    await flushPushes(b.profile_id, { service: fake, now: MORNING });
    expect(fake.sent.map((s) => s.payload.body)).toEqual([
      "1 thing waits for your yes, and a review worth knowing",
    ]);
  });

  it("a pasted review, or an account with no device, is settled without an alert", async () => {
    const b = await business();
    await device(b);
    const pasted = await alerted(b, new Date(MORNING.getTime() - 60_000), { source: "paste" });
    const fake = fakePushService();
    expect(await flushPushes(b.profile_id, { service: fake, now: MORNING })).toMatchObject({
      plan: "drop",
    });
    expect(fake.sent).toHaveLength(0);
    expect(await settledAt(pasted)).not.toBeNull();

    const bare = await business();
    const id = await alerted(bare, new Date(MORNING.getTime() - 60_000));
    await flushPushes(bare.profile_id, { service: fake, now: MORNING });
    expect(fake.sent).toHaveLength(0);
    expect(await settledAt(id)).not.toBeNull();
  });
});
