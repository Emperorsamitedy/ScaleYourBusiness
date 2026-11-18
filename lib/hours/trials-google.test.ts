// I-45a lifted (2026-11-16) — hours trials on the Google listing.
// Database-backed for the revert; the rest is pure.
//
// What it holds: a trial's hour maps onto the one time it moves on Google;
// only an hours proposal carrying a google_change is routed to the listing;
// a trial whose weeks are over gets ONE proposal to put the hour back, the
// other way round, never before its end and never twice; and declining that
// revert (keeping the trial's hours) never counts toward silencing trials.

import "dotenv/config";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "../../db";
import {
  accounts,
  businessProfiles,
  fieldRecords,
  intakeEvents,
  proposals,
  users,
} from "../../db/schema";
import { bootstrapIntake } from "../intake/service";
import { createProposal, rejectProposal } from "../proposals/service";
import { suppressedKinds } from "../trust/suppression";
import {
  HOURS_MODULE,
  TRIAL_KIND,
  hoursPlanFor,
  proposeTrialReverts,
  trialGoogleChange,
} from "./trials";

const created: { account_id: string; profile_id: string }[] = [];

beforeAll(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterAll(async () => {
  const ids = created.map((s) => s.profile_id);
  const accountIds = created.map((s) => s.account_id);
  if (ids.length === 0) return;
  await db.delete(proposals).where(inArray(proposals.profile_id, ids));
  await db.delete(intakeEvents).where(inArray(intakeEvents.profile_id, ids));
  await db.delete(fieldRecords).where(inArray(fieldRecords.profile_id, ids));
  await db.delete(users).where(inArray(users.account_id, accountIds));
  await db.delete(businessProfiles).where(inArray(businessProfiles.id, ids));
  await db.delete(accounts).where(inArray(accounts.id, accountIds));
});

describe("a trial's hour on Google", () => {
  it("opening earlier moves the open from the hour after to the hour", () => {
    expect(
      trialGoogleChange({ weekday: "fri", change: "open_earlier", hour: 8 }, "locations/2"),
    ).toEqual({
      location: "locations/2",
      weekday: "fri",
      edge: "open",
      from: 540,
      to: 480,
    });
  });

  it("closing earlier past midnight counts on from the trading day, as the trial does", () => {
    expect(
      trialGoogleChange({ weekday: "sat", change: "close_earlier", hour: 24 }, "locations/2"),
    ).toEqual({
      location: "locations/2",
      weekday: "sat",
      edge: "close",
      from: 1500,
      to: 1440,
    });
  });

  it("an opening that would need the day before isn't one ScaleX makes", () => {
    expect(
      trialGoogleChange({ weekday: "mon", change: "open_earlier", hour: -1 }, "locations/2"),
    ).toBeNull();
  });

  it("only an hours proposal with a google_change is routed to the listing", () => {
    const change = { location: "locations/2", weekday: "fri", edge: "open", from: 540, to: 480 };
    expect(
      hoursPlanFor({
        module: HOURS_MODULE,
        action: { kind: TRIAL_KIND, summary: "", detail: { google_change: change } },
      }),
    ).toEqual({ provider: "google_business_reviews", op: "set_regular_hours", params: change });
    expect(
      hoursPlanFor({ module: HOURS_MODULE, action: { kind: TRIAL_KIND, summary: "", detail: {} } }),
    ).toBeNull();
    expect(
      hoursPlanFor({
        module: "content",
        action: { kind: TRIAL_KIND, summary: "", detail: { google_change: change } },
      }),
    ).toBeNull();
    expect(
      hoursPlanFor({
        module: HOURS_MODULE,
        action: {
          kind: TRIAL_KIND,
          summary: "",
          detail: { google_change: { ...change, location: "../x" } },
        },
      }),
    ).toBeNull();
  });
});

async function business() {
  const s = await bootstrapIntake();
  created.push(s);
  const [owner] = await db
    .insert(users)
    .values({
      account_id: s.account_id,
      email: `hours-${crypto.randomUUID()}@test.local`,
      display_name: "Owner",
      role: "owner",
    })
    .returning();
  return { ...s, userId: owner!.id };
}

async function executedTrial(s: { profile_id: string; userId: string }, decidedDaysAgo: number) {
  const change = { location: "locations/222", weekday: "fri", edge: "open", from: 540, to: 480 };
  const row = await createProposal({
    profile_id: s.profile_id,
    module: HOURS_MODULE,
    originating_finding: `hours:fri:open_earlier:${crypto.randomUUID()}`,
    action: {
      kind: TRIAL_KIND,
      summary: "Open at 08:00 on Fridays for 4 weeks (a trial)",
      detail: {
        weekday: "fri",
        change: "open_earlier",
        hour: 8,
        trial_weeks: 4,
        currency: "EUR",
        anchor_minor: 0,
        hour_cost_minor: null,
        google_change: change,
      },
    },
    scenario: {} as never,
    reversibility: { level: "easy", if_you_change_your_mind: "fixture" },
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
  });
  const decided = new Date(Date.now() - decidedDaysAgo * 86_400_000).toISOString();
  await db
    .update(proposals)
    .set({
      status: "executed",
      decided_by: s.userId,
      decided_at: decided,
      execution_result: { weekday: "fri", edge: "open", from: 540, to: 480 },
    })
    .where(eq(proposals.id, row.id));
  return row.id;
}

describe("the trial's end on Google", () => {
  it("one proposal to put the hour back, after the weeks and not before, never twice", async () => {
    const s = await business();
    const running = await executedTrial(s, 10);
    const ended = await executedTrial(s, 40);
    const first = await proposeTrialReverts(s.profile_id);
    expect(first).toHaveLength(1);
    const revert = first[0]!;
    expect(revert.status).toBe("pending");
    const detail = (revert.action as { detail: Record<string, unknown> }).detail;
    expect(detail["revert_of"]).toBe(ended);
    expect(detail["google_change"]).toEqual({
      location: "locations/222",
      weekday: "fri",
      edge: "open",
      from: 480,
      to: 540,
    });
    expect(hoursPlanFor(revert)?.params).toMatchObject({ from: 480, to: 540 });
    expect(detail["revert_of"]).not.toBe(running);
    expect(await proposeTrialReverts(s.profile_id)).toEqual([]);
  });

  it("declining the revert keeps the hours, and never counts toward silencing trials", async () => {
    const s = await business();
    for (let i = 0; i < 3; i++) await executedTrial(s, 40 + i);
    const reverts = await proposeTrialReverts(s.profile_id);
    expect(reverts).toHaveLength(3);
    for (const r of reverts) {
      await rejectProposal({ proposalId: r.id, userId: s.userId, reason: "keeping the new hours" });
    }
    expect((await suppressedKinds(s.profile_id)).has(TRIAL_KIND)).toBe(false);
  });
});
