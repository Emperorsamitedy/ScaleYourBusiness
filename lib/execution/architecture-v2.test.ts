// Architecture v2's call order inside the engine — hard rule 1, I1 and I3.
// TrustLadder.authorize → ComplianceGate.check → ProofLedger.open_measurement
// → execute (or, in SHADOW, the counterfactual only). Against the real
// database and the in-repo fixture provider; no real platform anywhere.

import "dotenv/config";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "../../db";
import {
  accounts,
  businessProfiles,
  executionAttempts,
  executionHalts,
  executions,
  fieldRecords,
  intakeEvents,
  measurementPlans,
  modeDecisions,
  proposals,
  users,
} from "../../db/schema";
import { bootstrapIntake } from "../intake/service";
import { setStation } from "../ladder/ladder";
import { closePlan } from "../ledger/close";
import { planFromProposal } from "../ledger/from-proposal";
import { openPlan } from "../ledger/plans";
import { approveProposal, createProposal } from "../proposals/service";
import type { ProposalRow } from "../proposals/service";
import { executeProposal } from "./engine";
import { fixtureExecuteCalls, fixtureExecutor, fixtureReset } from "./providers/fixture";

const created: { account_id: string; profile_id: string }[] = [];
const noSleep = async () => undefined;

async function fresh() {
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
  const [u] = await db
    .insert(users)
    .values({
      account_id: s.account_id,
      email: `arch-v2-${crypto.randomUUID()}@test.local`,
      display_name: "Architecture v2 decider",
      role: "owner",
    })
    .returning({ id: users.id });
  return { ...s, user_id: u!.id };
}

const scenario = {
  assumptions: [],
  base_case: { case: "base", statement: "t", profit_delta_monthly: null, formula: null },
  downside_case: { case: "downside", statement: "t", profit_delta_monthly: null, formula: null },
  upside_case: { case: "upside", statement: "t", profit_delta_monthly: null, formula: null },
  breakeven_condition: "none — fixture",
} as never;

async function approved(s: { profile_id: string; user_id: string }): Promise<ProposalRow> {
  const row = await createProposal({
    profile_id: s.profile_id,
    module: "diagnosis",
    action: { kind: "operations_change", summary: "fixture action" },
    scenario,
    reversibility: { level: "easy", if_you_change_your_mind: "undo restores the previous value" },
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
  });
  return approveProposal({ proposalId: row.id, userId: s.user_id, executeNotBefore: null });
}

const run = (proposalId: string, provider = fixtureExecutor) =>
  executeProposal({
    proposalId,
    provider,
    op: "set_value",
    params: { key: "k", value: "new" },
    sleep: noSleep,
  });

/** The v1 spec §3.2's plans for a proposal (Session A's proof_ledger is no longer written). */
async function plansOf(proposalId: string) {
  return db.select().from(measurementPlans).where(eq(measurementPlans.proposal_id, proposalId));
}

async function claimOf(proposalId: string) {
  const [row] = await db.select().from(executions).where(eq(executions.proposal_id, proposalId));
  return row ?? null;
}

const savedRealWrites = process.env.SESSION_D_REAL_WRITES;
beforeEach(() => fixtureReset());
afterEach(() => {
  if (savedRealWrites === undefined) delete process.env.SESSION_D_REAL_WRITES;
  else process.env.SESSION_D_REAL_WRITES = savedRealWrites;
});

afterAll(async () => {
  const ids = created.map((s) => s.profile_id);
  if (ids.length > 0) {
    const rows = await db
      .select({ id: executions.id })
      .from(executions)
      .where(inArray(executions.profile_id, ids));
    const eids = rows.map((r) => r.id);
    if (eids.length > 0) {
      await db.delete(executionAttempts).where(inArray(executionAttempts.execution_id, eids));
    }
    await db.delete(executions).where(inArray(executions.profile_id, ids));
    await db.delete(proposals).where(inArray(proposals.profile_id, ids));
    await db.delete(modeDecisions).where(inArray(modeDecisions.profile_id, ids));
    await db.delete(intakeEvents).where(inArray(intakeEvents.profile_id, ids));
    await db.delete(fieldRecords).where(inArray(fieldRecords.profile_id, ids));
  }
  for (const s of created) {
    await db.delete(executionHalts).where(eq(executionHalts.account_id, s.account_id));
    await db.delete(users).where(eq(users.account_id, s.account_id));
  }
  // The ledger's rows stay (append-only); capability_stations cascade.
  if (ids.length > 0) await db.delete(businessProfiles).where(inArray(businessProfiles.id, ids));
  for (const s of created) await db.delete(accounts).where(eq(accounts.id, s.account_id));
});

describe("I1 — nothing runs without an open measurement plan, opened before it runs", () => {
  it("an approved action at the default station opens its plan, then executes", async () => {
    const s = await fresh();
    const p = await approved(s);
    const execution = await run(p.id);
    expect(execution.status).toBe("succeeded");
    expect(fixtureExecuteCalls()).toBe(1);
    const plans = await plansOf(p.id);
    expect(plans).toHaveLength(1);
    expect(plans[0]!).toMatchObject({
      capability: "fixture",
      provider: "fixture",
      action_summary: "fixture action",
      ladder_station_at_open: 3,
      shadow: false,
      opened_by: "agent",
    });
    // No money in the scenario: the plan says no forecast was made.
    expect(plans[0]!.hypothesis).toMatch(/No forecast in money/);
    // Opened BEFORE execution: the plan predates the execution's own start.
    expect(Date.parse(plans[0]!.opened_at)).toBeLessThanOrEqual(Date.parse(execution.started_at));
  });

  it("a plan already closed is not a plan: the engine refuses, a hard error, and runs nothing", async () => {
    const s = await fresh();
    const p = await approved(s);
    const { plan } = await openPlan(
      planFromProposal(p, {
        accountId: s.account_id,
        provider: "fixture",
        op: "set_value",
        reversible: true,
        station: 3,
        shadow: false,
        now: new Date("2026-01-01T00:00:00Z"),
      }),
    );
    await closePlan(plan.id, { inconclusive: "closed before it ran" });
    await expect(run(p.id)).rejects.toMatchObject({ code: "no_measurement" });
    expect(fixtureExecuteCalls()).toBe(0);
    expect(await claimOf(p.id)).toBeNull();
  });

  it("a retried execution reads the same plan — one plan per action", async () => {
    const s = await fresh();
    const p = await approved(s);
    await run(p.id);
    await run(p.id); // already succeeded: returns the existing run
    expect(await plansOf(p.id)).toHaveLength(1);
  });

  it("ComplianceGate refuses an external capability with no write consent — over the ladder's yes", async () => {
    process.env.SESSION_D_REAL_WRITES = "on";
    const s = await fresh();
    const p = await approved(s);
    // Station 3 and an approved proposal: the ladder says yes. The gate says no.
    await expect(run(p.id, { ...fixtureExecutor, external: true })).rejects.toMatchObject({
      code: "compliance",
      message: expect.stringMatching(/no live write consent/),
    });
    expect(fixtureExecuteCalls()).toBe(0);
    expect(await claimOf(p.id)).toBeNull();
    // Refused before a measurement was opened: step 3 never ran.
    expect(await plansOf(p.id)).toHaveLength(0);
  });
});

describe("I3 — station 1 or 2 never produces an external side effect, whoever calls", () => {
  it("station 1 (BLOCKED) refuses before anything is opened or claimed", async () => {
    const s = await fresh();
    await setStation({ profileId: s.profile_id, capability: "fixture", station: 1, by: null });
    const p = await approved(s);
    await expect(run(p.id)).rejects.toMatchObject({ code: "ladder_blocked" });
    expect(fixtureExecuteCalls()).toBe(0);
    expect(await claimOf(p.id)).toBeNull();
    expect(await plansOf(p.id)).toHaveLength(0);
  });

  it("station 2 (SHADOW) records the counterfactual against an open plan, and runs nothing", async () => {
    const s = await fresh();
    await setStation({ profileId: s.profile_id, capability: "fixture", station: 2, by: null });
    const p = await approved(s);
    await expect(run(p.id)).rejects.toMatchObject({ code: "shadow" });
    // A second run (the due runner) records nothing new.
    await expect(run(p.id)).rejects.toMatchObject({ code: "shadow" });
    expect(fixtureExecuteCalls()).toBe(0);
    expect(await claimOf(p.id)).toBeNull();
    // One plan, marked shadow at open: what would have been done, and nothing was.
    const rows = await plansOf(p.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ shadow: true, ladder_station_at_open: 2 });
    expect(rows[0]!.action_summary).toBe("fixture action");
    // The proposal stays approved: SHADOW is the ladder's answer, not the owner's.
    const [row] = await db
      .select()
      .from(proposals)
      .where(and(eq(proposals.id, p.id)));
    expect(row?.status).toBe("approved");
  });

  it("an external capability at station 1 is refused by the ladder before the gate is asked", async () => {
    process.env.SESSION_D_REAL_WRITES = "on";
    const s = await fresh();
    await setStation({ profileId: s.profile_id, capability: "fixture", station: 1, by: null });
    const p = await approved(s);
    await expect(run(p.id, { ...fixtureExecutor, external: true })).rejects.toMatchObject({
      code: "ladder_blocked",
    });
    expect(fixtureExecuteCalls()).toBe(0);
  });
});
