// The ownership clauses — 2026-09-26 security review, defensive note.
//
// UUIDs are unguessable, so none of this was exploitable — but any
// future id disclosure would have turned a valid session plus a
// foreign id into a cross-account approve/apply/undo/produce
// primitive. Now every scoped operation answers a foreign profile's
// id with 404, "no such" — never confirming existence across the
// boundary — and still works for the caller's own profile.

import "dotenv/config";
import { eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "../../db";
import {
  accounts,
  businessProfiles,
  executionAttempts,
  executions,
  fieldRecords,
  intakeEvents,
  modeDecisions,
  proposals,
  users,
} from "../../db/schema";
import { bootstrapIntake } from "../intake/service";
import { executeProposal, undoExecution } from "../execution/engine";
import { fixtureExecutor } from "../execution/providers/fixture";
import { produceFromProposal } from "../content/produce";
import { applySiteChange } from "../site/apply";
import { approveProposal, createProposal, rejectProposal } from "./service";

const created: { account_id: string; profile_id: string }[] = [];
const noSleep = async () => undefined;

const scenario = {
  assumptions: [],
  base_case: { case: "base", statement: "t", profit_delta_monthly: null, formula: null },
  downside_case: { case: "downside", statement: "t", profit_delta_monthly: null, formula: null },
  upside_case: { case: "upside", statement: "t", profit_delta_monthly: null, formula: null },
  breakeven_condition: "none — fixture",
} as never;

async function fresh() {
  const s = await bootstrapIntake();
  created.push(s);
  await db.insert(modeDecisions).values({
    profile_id: s.profile_id,
    mode: "instant",
    inputs: { reasons: ["fixture"] },
    reasoning: "fixture",
    confidence: "0.900",
    review_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
  });
  const [u] = await db
    .insert(users)
    .values({
      account_id: s.account_id,
      email: `own-${crypto.randomUUID()}@test.local`,
      display_name: "Ownership test owner",
      role: "owner",
    })
    .returning({ id: users.id });
  return { ...s, user_id: u!.id };
}

function pending(profileId: string, kind = "operations_change") {
  return createProposal({
    profile_id: profileId,
    module: "diagnosis",
    action: { kind, summary: "ownership fixture" },
    scenario,
    reversibility: { level: "easy", if_you_change_your_mind: "undo" },
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
  });
}

afterAll(async () => {
  const ids = created.map((s) => s.profile_id);
  if (ids.length > 0) {
    const rows = await db
      .select({ id: executions.id })
      .from(executions)
      .where(inArray(executions.profile_id, ids));
    if (rows.length > 0)
      await db.delete(executionAttempts).where(
        inArray(
          executionAttempts.execution_id,
          rows.map((r) => r.id),
        ),
      );
    await db.delete(executions).where(inArray(executions.profile_id, ids));
    await db.delete(proposals).where(inArray(proposals.profile_id, ids));
    await db.delete(modeDecisions).where(inArray(modeDecisions.profile_id, ids));
    await db.delete(intakeEvents).where(inArray(intakeEvents.profile_id, ids));
    await db.delete(fieldRecords).where(inArray(fieldRecords.profile_id, ids));
  }
  for (const s of created) {
    await db.delete(users).where(eq(users.account_id, s.account_id));
  }
  if (ids.length > 0) await db.delete(businessProfiles).where(inArray(businessProfiles.id, ids));
  for (const s of created) {
    await db.delete(accounts).where(eq(accounts.id, s.account_id));
  }
});

describe("ownership clauses — foreign ids are 'no such', own ids still work", () => {
  it("deciding: a valid session cannot approve or reject another profile's proposal", async () => {
    const alice = await fresh();
    const mallory = await fresh();
    const target = await pending(alice.profile_id);

    await expect(
      approveProposal({
        proposalId: target.id,
        userId: mallory.user_id,
        profileId: mallory.profile_id, // Mallory's own scope
      }),
    ).rejects.toThrow(/no such proposal/);
    await expect(
      rejectProposal({
        proposalId: target.id,
        userId: mallory.user_id,
        reason: "mine now",
        profileId: mallory.profile_id,
      }),
    ).rejects.toThrow(/no such proposal/);

    // Untouched, and Alice's own scoped approval still works.
    const [row] = await db.select().from(proposals).where(eq(proposals.id, target.id));
    expect(row?.status).toBe("pending");
    const approved = await approveProposal({
      proposalId: target.id,
      userId: alice.user_id,
      profileId: alice.profile_id,
    });
    expect(approved.status).toBe("approved");
  });

  it("undo: another profile's execution id is 'no such execution'", async () => {
    const alice = await fresh();
    const mallory = await fresh();
    const proposal = await pending(alice.profile_id);
    await approveProposal({ proposalId: proposal.id, userId: alice.user_id });
    const execution = await executeProposal({
      proposalId: proposal.id,
      provider: fixtureExecutor,
      op: "set_value",
      params: { key: "k", value: "v" },
      sleep: noSleep,
    });

    await expect(
      undoExecution({
        executionId: execution.id,
        provider: fixtureExecutor,
        userId: mallory.user_id,
        expectedProfileId: mallory.profile_id,
      }),
    ).rejects.toThrow(/no such execution/);

    const undone = await undoExecution({
      executionId: execution.id,
      provider: fixtureExecutor,
      userId: alice.user_id,
      expectedProfileId: alice.profile_id,
    });
    expect(undone.status).toBe("undone");
  });

  it("site apply: another profile's site proposal is 'no such proposal'", async () => {
    const alice = await fresh();
    const mallory = await fresh();
    // A minimal site proposal shaped like changes.ts produces.
    const siteProposal = await createProposal({
      profile_id: alice.profile_id,
      module: "site",
      action: {
        kind: "operations_change",
        summary: "ownership fixture",
        detail: {
          url: "https://emberworks.example/about",
          find: "a",
          replace: "b",
          platform: { platform: "custom", editable: "unknown", marker: "t" },
          platform_line: "t",
          site_preview: null,
          preview_note: null,
          manual_instructions: null,
          health_baseline_ms: 50,
          manual_limits: [],
          rationale: "t",
        },
      },
      scenario,
      reversibility: { level: "easy", if_you_change_your_mind: "undo" },
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    });
    await expect(
      applySiteChange({ proposalId: siteProposal.id, expectedProfileId: mallory.profile_id }),
    ).rejects.toThrow(/no such proposal/);
  });

  it("produce: another profile's content proposal is 'no such proposal'", async () => {
    const alice = await fresh();
    const mallory = await fresh();
    const plan = await pending(alice.profile_id, "content_publishing");
    await approveProposal({ proposalId: plan.id, userId: alice.user_id });
    await expect(
      produceFromProposal(plan.id, { expectedProfileId: mallory.profile_id }),
    ).rejects.toThrow(/no such proposal/);
    const [row] = await db.select().from(proposals).where(eq(proposals.id, plan.id));
    expect(row?.status).toBe("approved"); // untouched
  });
});
