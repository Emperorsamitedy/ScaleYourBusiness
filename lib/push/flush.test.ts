// Idea 53 (I-53.4) against the database: the outbox written by
// createProposal, and the flush carrying out pushPlan through the fake push
// service (no network). Clocks are pinned to a Tuesday in November:
// Budapest is UTC+1.

import "dotenv/config";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "../../db";
import { businessProfiles, executionHalts, proposals, pushOutbox } from "../../db/schema";
import type { ScenarioBlock } from "../diagnosis/recommendations";
import { createProposal } from "../proposals/service";
import { enqueuePush, flushHeldPushes, flushPushes, queuedFor, sendTestPush } from "./flush";
import { fakePushService } from "./send";
import { listDevices } from "./subscriptions";
import { business, cleanup, device } from "./test-fixtures";

const MORNING = new Date("2026-11-10T09:00:00Z"); // 10:00 in Budapest
const EVENING = new Date("2026-11-10T21:30:00Z"); // 22:30
const NEXT_MORNING = new Date("2026-11-11T07:05:00Z"); // 08:05

const scenario: ScenarioBlock = {
  assumptions: [],
  base_case: { case: "base", statement: "t", profit_delta_monthly: null, formula: null },
  downside_case: { case: "downside", statement: "t", profit_delta_monthly: null, formula: null },
  upside_case: { case: "upside", statement: "t", profit_delta_monthly: null, formula: null },
  breakeven_condition: "none — test fixture",
};

function draft(profileId: string, over: { blocked?: string; summary?: string } = {}) {
  return {
    profile_id: profileId,
    module: "diagnosis",
    action: {
      kind: "price_increase",
      summary: over.summary ?? "Raise the espresso to 1 400 Ft for Anna Kovács",
    },
    scenario,
    reversibility: { level: "easy" as const, if_you_change_your_mind: "change it back" },
    expires_at: "2027-01-31T00:00:00.000Z",
    ...(over.blocked ? { blocked_by_limit: over.blocked } : {}),
  };
}

afterAll(cleanup);

describe("queueing in createProposal", () => {
  it("queues a pending proposal when the account has a device", async () => {
    const b = await business();
    await device(b);
    const p = await createProposal(draft(b.profile_id));
    expect(await queuedFor(b.profile_id)).toEqual([p.id]);
  });

  it("queues nothing when no device is switched on", async () => {
    const b = await business();
    await createProposal(draft(b.profile_id));
    expect(await queuedFor(b.profile_id)).toEqual([]);
  });

  it("queues nothing for a blocked proposal", async () => {
    const b = await business();
    await device(b);
    await createProposal(draft(b.profile_id, { blocked: "13.5: never raise prices" }));
    expect(await queuedFor(b.profile_id)).toEqual([]);
  });

  it("a failed enqueue never fails the transaction it sits in", async () => {
    const b = await business();
    const ok = await db.transaction(async (tx) => {
      const queued = await enqueuePush(tx, {
        id: "not-a-uuid",
        profile_id: b.profile_id,
        status: "pending",
      });
      // The transaction is still usable after the savepoint rolled back.
      const [row] = await tx
        .select({ id: businessProfiles.id })
        .from(businessProfiles)
        .where(eq(businessProfiles.id, b.profile_id));
      return { queued, still: row?.id };
    });
    expect(ok).toEqual({ queued: false, still: b.profile_id });
  });

  it("a proposal rolled back with its caller's transaction leaves no push behind", async () => {
    const b = await business();
    await device(b);
    await expect(
      db.transaction(async (tx) => {
        await createProposal(draft(b.profile_id), tx);
        throw new Error("the caller changed its mind");
      }),
    ).rejects.toThrow(/changed its mind/);
    expect(await queuedFor(b.profile_id)).toEqual([]);
  });
});

describe("the flush", () => {
  it("sends one alert for a run's proposals, to every device, in a few words", async () => {
    const b = await business();
    await device(b);
    await device(b, { ua: "Android" });
    await createProposal(draft(b.profile_id));
    await createProposal(draft(b.profile_id));
    await createProposal(draft(b.profile_id));
    const fake = fakePushService();
    const out = await flushPushes(b.profile_id, { service: fake, now: MORNING });
    expect(out).toMatchObject({ plan: "send", sent: 2, gone: 0, failed: 0 });
    expect(fake.sent.map((s) => s.payload.body)).toEqual([
      "3 things wait for your yes",
      "3 things wait for your yes",
    ]);
    expect(fake.sent[0]?.payload.url).toBe("/proposals");
    expect(await queuedFor(b.profile_id)).toEqual([]);
    const devices = await listDevices(b.account_id, null);
    expect(devices.every((d) => d.last_sent_at !== null)).toBe(true);
  });

  it("a single proposal's alert opens its card and carries none of its own words", async () => {
    const b = await business();
    await device(b);
    const p = await createProposal(draft(b.profile_id));
    const fake = fakePushService();
    await flushPushes(b.profile_id, { service: fake, now: MORNING });
    expect(fake.sent[0]?.payload).toMatchObject({
      body: "1 thing waits for your yes: a price change",
      url: `/proposals/${p.id}`,
    });
    expect(JSON.stringify(fake.sent[0]?.payload)).not.toMatch(/Anna|Kovács|1 400|Ft/);
  });

  it("holds through quiet hours and sends at 08:00 on the morning beat", async () => {
    const b = await business();
    await device(b);
    const p = await createProposal(draft(b.profile_id));
    const fake = fakePushService();
    expect(await flushPushes(b.profile_id, { service: fake, now: EVENING })).toMatchObject({
      plan: "hold",
      why: "quiet_hours",
      sent: 0,
    });
    expect(await queuedFor(b.profile_id)).toEqual([p.id]);
    const beat = await flushHeldPushes({ service: fake, now: NEXT_MORNING });
    expect(beat.sent).toBeGreaterThanOrEqual(1);
    expect(fake.sent.map((s) => s.payload.url)).toContain(`/proposals/${p.id}`);
    expect(await queuedFor(b.profile_id)).toEqual([]);
  });

  it("sends at most one alert a day; the second waits for the next morning", async () => {
    const b = await business();
    await device(b);
    await createProposal(draft(b.profile_id));
    const fake = fakePushService();
    await flushPushes(b.profile_id, { service: fake, now: MORNING });
    const later = await createProposal(draft(b.profile_id));
    const afternoon = new Date("2026-11-10T14:00:00Z");
    expect(await flushPushes(b.profile_id, { service: fake, now: afternoon })).toMatchObject({
      plan: "hold",
      why: "daily_cap",
    });
    expect(fake.sent).toHaveLength(1);
    expect(await queuedFor(b.profile_id)).toEqual([later.id]);
  });

  it("sends nothing while the emergency stop is on, and drops what was queued", async () => {
    const b = await business();
    await device(b);
    await createProposal(draft(b.profile_id));
    await db.insert(executionHalts).values({ account_id: b.account_id, halted_by: b.user_id });
    const fake = fakePushService();
    expect(await flushPushes(b.profile_id, { service: fake, now: MORNING })).toMatchObject({
      plan: "drop",
      why: "halted",
    });
    expect(fake.sent).toHaveLength(0);
    expect(await queuedFor(b.profile_id)).toEqual([]);
  });

  it("drops a proposal decided before its alert went", async () => {
    const b = await business();
    await device(b);
    const p = await createProposal(draft(b.profile_id));
    await db.update(proposals).set({ status: "expired" }).where(eq(proposals.id, p.id));
    const fake = fakePushService();
    expect(await flushPushes(b.profile_id, { service: fake, now: MORNING })).toMatchObject({
      plan: "drop",
      why: "nothing_waiting",
    });
    expect(fake.sent).toHaveLength(0);
  });

  it("a 410 deletes that subscription; a failure is kept and not retried", async () => {
    const b = await business();
    const dead = await device(b);
    const flaky = await device(b, { ua: "Android" });
    const kept = await device(b, { ua: "Macintosh" });
    await createProposal(draft(b.profile_id));
    const fake = fakePushService({
      gone: new Set([dead.endpoint]),
      failing: new Set([flaky.endpoint]),
    });
    const out = await flushPushes(b.profile_id, { service: fake, now: MORNING });
    expect(out).toMatchObject({ plan: "send", sent: 1, gone: 1, failed: 1 });
    const left = (await listDevices(b.account_id, null)).map((d) => d.id).sort();
    expect(left).toEqual([flaky.id, kept.id].sort());
    expect(fake.sent).toHaveLength(1);
  });

  it("two flushes racing for one account send once", async () => {
    const b = await business();
    await device(b);
    await createProposal(draft(b.profile_id));
    const fake = fakePushService();
    const [x, y] = await Promise.all([
      flushPushes(b.profile_id, { service: fake, now: MORNING }),
      flushPushes(b.profile_id, { service: fake, now: MORNING }),
    ]);
    expect([x.plan, y.plan].sort()).toEqual(["nothing", "send"]);
    expect(fake.sent).toHaveLength(1);
  });
});

describe("a test alongside the real thing", () => {
  it("a test doesn't use the day's one alert", async () => {
    const b = await business();
    await device(b);
    const fake = fakePushService();
    await sendTestPush(b.account_id, fake);
    await createProposal(draft(b.profile_id));
    expect((await flushPushes(b.profile_id, { service: fake, now: MORNING })).plan).toBe("send");
  });
});

describe("the outbox holds ids only", () => {
  it("has a proposal id, a profile id and a time, nothing else", async () => {
    const b = await business();
    await device(b);
    await createProposal(draft(b.profile_id));
    const rows = await db.select().from(pushOutbox).where(eq(pushOutbox.profile_id, b.profile_id));
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual(["created_at", "profile_id", "proposal_id"]);
  });
});
