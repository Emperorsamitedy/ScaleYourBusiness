// Station 4 in the engine — the v1 spec §4.1, §4.4, §4.7; D21, D36.
// "Caps are enforced server-side; a tampered client payload cannot exceed
// them." A pending proposal runs without a per-action approval only at
// station 4, within the stored caps and standing rules; otherwise it waits.

import "dotenv/config";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "../../db";
import {
  accounts,
  businessProfiles,
  capabilityCaps,
  capabilityStations,
  decisionLog,
  executionAttempts,
  executions,
  fieldRecords,
  intakeEvents,
  limitActions,
  modeDecisions,
  proposals,
} from "../../db/schema";
import { bootstrapIntake } from "../intake/service";
import { setCaps } from "../ladder/caps";
import { addStandingRule } from "../ladder/standing-rules";
import { createProposal } from "../proposals/service";
import { executeProposal } from "./engine";
import { fixtureExecuteCalls, fixtureExecutor, fixtureReset } from "./providers/fixture";

const created: { account_id: string; profile_id: string }[] = [];
beforeEach(() => fixtureReset());

afterAll(async () => {
  const ids = created.map((s) => s.profile_id);
  const ex = await db
    .select({ id: executions.id })
    .from(executions)
    .where(inArray(executions.profile_id, ids));
  if (ex.length)
    await db.delete(executionAttempts).where(
      inArray(
        executionAttempts.execution_id,
        ex.map((e) => e.id),
      ),
    );
  await db.delete(executions).where(inArray(executions.profile_id, ids));
  await db.delete(proposals).where(inArray(proposals.profile_id, ids));
  await db.delete(modeDecisions).where(inArray(modeDecisions.profile_id, ids));
  await db.delete(intakeEvents).where(inArray(intakeEvents.profile_id, ids));
  await db.delete(fieldRecords).where(inArray(fieldRecords.profile_id, ids));
  await db.delete(businessProfiles).where(inArray(businessProfiles.id, ids));
  for (const s of created) await db.delete(accounts).where(eq(accounts.id, s.account_id));
});

const CAPS = {
  currency: "EUR",
  max_daily_spend_delta_minor: null,
  max_single_action_minor: 5_000,
  max_actions_per_day: 2,
  blackout_windows: [],
  require_approval_above_minor: 3_000,
  never_touch: ["flagship"],
};

async function atStation4() {
  const s = await bootstrapIntake();
  created.push(s);
  await db.insert(modeDecisions).values({
    profile_id: s.profile_id,
    mode: "instant",
    inputs: { reasons: ["test fixture"] },
    reasoning: "test fixture",
    confidence: "0.900",
    review_at: new Date(Date.now() + 42 * 86_400_000).toISOString(),
  });
  // Promoted through the evidence rules elsewhere (lib/ladder/v1-ladder.test.ts);
  // here the station is written straight in to test the engine's side.
  await db
    .insert(capabilityStations)
    .values({ profile_id: s.profile_id, capability: "fixture", station: 4 });
  await setCaps({ profileId: s.profile_id, capability: "fixture", caps: CAPS, by: null });
  return s;
}

async function pending(profileId: string) {
  return createProposal({
    profile_id: profileId,
    module: "diagnosis",
    action: { kind: "operations_change", summary: "fixture action within limits" },
    scenario: {
      assumptions: [],
      base_case: { case: "base", statement: "t", profit_delta_monthly: null, formula: null },
      downside_case: {
        case: "downside",
        statement: "t",
        profit_delta_monthly: null,
        formula: null,
      },
      upside_case: { case: "upside", statement: "t", profit_delta_monthly: null, formula: null },
      breakeven_condition: "none",
    } as never,
    reversibility: { level: "easy", if_you_change_your_mind: "undo restores it" },
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
  });
}

const run = (proposalId: string, params: Record<string, unknown>) =>
  executeProposal({
    proposalId,
    provider: fixtureExecutor,
    op: "set_value",
    params,
    sleep: async () => undefined,
  });

describe("station 4 — acts within the owner's limits, reports after", () => {
  it("a pending proposal within the caps runs, approved by the ladder, never by a person", async () => {
    const s = await atStation4();
    const p = await pending(s.profile_id);
    const e = await run(p.id, { key: "k", value: "v", amount_minor: 2_000, currency: "EUR" });
    expect(e.status).toBe("succeeded");
    expect(fixtureExecuteCalls()).toBe(1);
    const [row] = await db.select().from(proposals).where(eq(proposals.id, p.id));
    expect(row?.decided_by).toBeNull();
    const [log] = await db
      .select()
      .from(decisionLog)
      .where(and(eq(decisionLog.ref_id, p.id), eq(decisionLog.kind, "approval")));
    expect(log?.actor).toBe("system");
    const acts = await db.select().from(limitActions).where(eq(limitActions.proposal_id, p.id));
    expect(acts).toHaveLength(1);
  });

  it("above the soft ceiling it waits for the owner's yes, as at station 3", async () => {
    const s = await atStation4();
    const p = await pending(s.profile_id);
    await expect(
      run(p.id, { key: "k", value: "v", amount_minor: 4_000, currency: "EUR" }),
    ).rejects.toMatchObject({
      code: "not_approved",
    });
    expect(fixtureExecuteCalls()).toBe(0);
    const [row] = await db.select().from(proposals).where(eq(proposals.id, p.id));
    expect(row?.status).toBe("pending");
  });

  it("a payload over the hard cap, or naming something never to touch, is refused — nothing runs", async () => {
    const s = await atStation4();
    const big = await pending(s.profile_id);
    await expect(
      run(big.id, { key: "k", value: "v", amount_minor: 9_999_999, currency: "EUR" }),
    ).rejects.toMatchObject({
      code: "limits",
    });
    const flagship = await pending(s.profile_id);
    await expect(run(flagship.id, { key: "flagship", value: "v" })).rejects.toMatchObject({
      code: "limits",
    });
    expect(fixtureExecuteCalls()).toBe(0);
  });

  it("the daily count comes from what station 4 already did, not from the caller", async () => {
    const s = await atStation4();
    for (let i = 0; i < 2; i++)
      await run((await pending(s.profile_id)).id, { key: `k${i}`, value: "v" });
    await expect(
      run((await pending(s.profile_id)).id, { key: "k3", value: "v" }),
    ).rejects.toMatchObject({
      code: "limits",
      message: expect.stringMatching(/action 3 today/),
    });
    expect(fixtureExecuteCalls()).toBe(2);
  });

  it("a standing rule asking for approval sends it back to the owner", async () => {
    const s = await atStation4();
    await addStandingRule({
      profileId: s.profile_id,
      scope: "fixture",
      condition: { kind: "always" },
      action: "require_approval",
      words: "Ask me first",
      by: null,
    });
    await expect(
      run((await pending(s.profile_id)).id, { key: "k", value: "v" }),
    ).rejects.toMatchObject({
      code: "not_approved",
    });
  });

  it("without caps, station 4 acts on nothing", async () => {
    const s = await atStation4();
    await db.delete(capabilityCaps).where(eq(capabilityCaps.profile_id, s.profile_id));
    await expect(
      run((await pending(s.profile_id)).id, { key: "k", value: "v" }),
    ).rejects.toMatchObject({
      code: "limits",
    });
  });

  it("at station 3 a pending proposal still needs the owner's yes", async () => {
    const s = await bootstrapIntake();
    created.push(s);
    await db.insert(modeDecisions).values({
      profile_id: s.profile_id,
      mode: "instant",
      inputs: { reasons: ["t"] },
      reasoning: "t",
      confidence: "0.900",
      review_at: new Date(Date.now() + 86_400_000).toISOString(),
    });
    await expect(
      run((await pending(s.profile_id)).id, { key: "k", value: "v" }),
    ).rejects.toMatchObject({
      code: "not_approved",
    });
  });
});
