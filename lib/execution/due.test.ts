// P3-20e — the due runner, as D0's done-when: an approved fixture
// proposal with a past execute_not_before executes on the next runner
// call and not before; a second call is a no-op; a halted account is
// skipped; a failed run is never retried by the clock; an approval
// nothing knows how to run is left alone and said so; expiry is swept.

import "dotenv/config";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "../../db";
import {
  accounts,
  businessProfiles,
  executionAttempts,
  executionHalts,
  executions,
  fieldRecords,
  intakeEvents,
  modeDecisions,
  proposals,
  users,
} from "../../db/schema";
import { bootstrapIntake } from "../intake/service";
import { approveProposal, createProposal } from "../proposals/service";
import type { ProposalRow } from "../proposals/service";
import { preboundPlan, runDueExecutions } from "./due";
import { haltExecutions, resumeExecutions } from "./engine";
import {
  fixtureExecuteCalls,
  fixtureFailNextAttempts,
  fixtureRead,
  fixtureReset,
} from "./providers/fixture";

const created: { account_id: string; profile_id: string }[] = [];
const noSleep = async () => undefined;
const PAST = new Date(Date.now() - 3_600_000).toISOString();
const FUTURE = new Date(Date.now() + 3_600_000).toISOString();

async function fresh() {
  const s = await bootstrapIntake();
  created.push(s);
  await db.insert(modeDecisions).values({
    profile_id: s.profile_id,
    mode: "instant",
    watch_weeks: null,
    inputs: { reasons: ["test fixture"] },
    reasoning: "test fixture",
    confidence: "0.900",
    review_at: new Date(Date.now() + 42 * 86_400_000).toISOString(),
  });
  const [u] = await db
    .insert(users)
    .values({
      account_id: s.account_id,
      email: `p3-20e-${crypto.randomUUID()}@test.local`,
      display_name: "Due runner decider",
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

/** An approved, pre-bound fixture proposal: the runner knows exactly what to run. */
async function scheduled(
  s: { profile_id: string; user_id: string },
  args: {
    executeNotBefore?: string | null;
    key?: string;
    value?: unknown;
    prebound?: boolean;
  } = {},
): Promise<ProposalRow> {
  const prebound = args.prebound ?? true;
  const row = await createProposal({
    profile_id: s.profile_id,
    module: "diagnosis",
    action: {
      kind: "operations_change",
      summary: "fixture action",
      ...(prebound
        ? {
            detail: {
              execution: {
                provider: "fixture",
                op: "set_value",
                params: { key: args.key ?? "k", value: args.value ?? "v" },
              },
            },
          }
        : {}),
    },
    scenario,
    reversibility: { level: "easy", if_you_change_your_mind: "undo restores the previous value" },
    expires_at: FUTURE,
  });
  return approveProposal({
    proposalId: row.id,
    userId: s.user_id,
    executeNotBefore: args.executeNotBefore === undefined ? PAST : args.executeNotBefore,
  });
}

const run = (profileId: string) => runDueExecutions({ profileId, sleep: noSleep });

beforeEach(() => fixtureReset());

afterAll(async () => {
  const ids = created.map((s) => s.profile_id);
  if (ids.length > 0) {
    const rows = await db
      .select({ id: executions.id })
      .from(executions)
      .where(inArray(executions.profile_id, ids));
    const eids = rows.map((r) => r.id);
    if (eids.length > 0)
      await db.delete(executionAttempts).where(inArray(executionAttempts.execution_id, eids));
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
  if (ids.length > 0) await db.delete(businessProfiles).where(inArray(businessProfiles.id, ids));
  for (const s of created) await db.delete(accounts).where(eq(accounts.id, s.account_id));
});

describe("P3-20e — preboundPlan", () => {
  it("reads a well-formed plan and refuses anything else", () => {
    const base = { action: {} } as unknown as ProposalRow;
    expect(preboundPlan(base)).toBeNull();
    const ok = {
      action: {
        detail: { execution: { provider: "fixture", op: "set_value", params: { key: "k" } } },
      },
    } as unknown as ProposalRow;
    expect(preboundPlan(ok)).toEqual({
      provider: "fixture",
      op: "set_value",
      params: { key: "k" },
    });
    const unregistered = {
      action: { detail: { execution: { provider: "meta", op: "publish", params: {} } } },
    } as unknown as ProposalRow;
    expect(preboundPlan(unregistered)).toBeNull();
    const noOp = {
      action: { detail: { execution: { provider: "fixture", op: "", params: {} } } },
    } as unknown as ProposalRow;
    expect(preboundPlan(noOp)).toBeNull();
    const noParams = {
      action: { detail: { execution: { provider: "fixture", op: "set_value" } } },
    } as unknown as ProposalRow;
    expect(preboundPlan(noParams)).toEqual({ provider: "fixture", op: "set_value", params: {} });
  });
});

describe("P3-20e — the due runner", () => {
  it("executes a due approval on the next call and NOT before; a second call is a no-op", async () => {
    const s = await fresh();
    const later = await scheduled(s, { executeNotBefore: FUTURE, key: "later", value: 1 });
    const now = await scheduled(s, { key: "now", value: "ran" });
    const unscheduled = await scheduled(s, { executeNotBefore: null, key: "manual", value: 2 });

    const first = await run(s.profile_id);
    expect(first.due).toBe(1);
    expect(first.executed).toBe(1);
    expect(first.outcomes.map((o) => [o.proposal_id, o.result])).toEqual([[now.id, "executed"]]);
    expect(fixtureRead(s.profile_id, "now")).toBe("ran");
    expect(fixtureRead(s.profile_id, "later")).toBeUndefined();
    expect(fixtureRead(s.profile_id, "manual")).toBeUndefined();

    const [ran] = await db.select().from(proposals).where(eq(proposals.id, now.id));
    expect(ran?.status).toBe("executed");
    const [stillLater] = await db.select().from(proposals).where(eq(proposals.id, later.id));
    expect(stillLater?.status).toBe("approved");
    const [stillManual] = await db.select().from(proposals).where(eq(proposals.id, unscheduled.id));
    expect(stillManual?.status).toBe("approved");

    const calls = fixtureExecuteCalls();
    const second = await run(s.profile_id);
    expect(second.due).toBe(0);
    expect(second.executed).toBe(0);
    expect(fixtureExecuteCalls()).toBe(calls);
  });

  it("a halted account is skipped without touching the engine, and runs after resume", async () => {
    const s = await fresh();
    await scheduled(s, { key: "stopped", value: "x" });
    await haltExecutions({ accountId: s.account_id, reason: "test" });

    const halted = await run(s.profile_id);
    expect(halted.due).toBe(1);
    expect(halted.halted).toBe(1);
    expect(halted.executed).toBe(0);
    expect(fixtureRead(s.profile_id, "stopped")).toBeUndefined();
    expect(
      await db.select().from(executions).where(eq(executions.profile_id, s.profile_id)),
    ).toEqual([]);

    await resumeExecutions(s.account_id);
    const resumed = await run(s.profile_id);
    expect(resumed.executed).toBe(1);
    expect(fixtureRead(s.profile_id, "stopped")).toBe("x");
  });

  it("a failed run is recorded once and never retried by the clock", async () => {
    const s = await fresh();
    const p = await scheduled(s, { key: "flaky", value: "y" });
    fixtureFailNextAttempts(3);

    const first = await run(s.profile_id);
    expect(first.failed).toBe(1);
    expect(first.outcomes[0]?.detail).toMatch(/injected failure/);
    const [exec] = await db.select().from(executions).where(eq(executions.proposal_id, p.id));
    expect(exec?.status).toBe("failed");
    expect(exec?.attempts).toBe(3);

    const calls = fixtureExecuteCalls();
    const second = await run(s.profile_id);
    expect(second.due).toBe(0);
    expect(fixtureExecuteCalls()).toBe(calls);
    const [still] = await db.select().from(proposals).where(eq(proposals.id, p.id));
    expect(still?.status).toBe("approved");
  });

  it("an approval nothing knows how to run is left approved and said so — the runner never guesses", async () => {
    const s = await fresh();
    const p = await scheduled(s, { prebound: false });
    const summary = await run(s.profile_id);
    expect(summary.due).toBe(1);
    expect(summary.unroutable).toBe(1);
    expect(summary.outcomes[0]?.detail).toMatch(
      /no executor knows how to run a "diagnosis" proposal/,
    );
    const [still] = await db.select().from(proposals).where(eq(proposals.id, p.id));
    expect(still?.status).toBe("approved");
    expect(await db.select().from(executions).where(eq(executions.proposal_id, p.id))).toEqual([]);
  });

  it("sweeps expiry first: a pending proposal past its window becomes expired, never rejected", async () => {
    const s = await fresh();
    const stale = await createProposal({
      profile_id: s.profile_id,
      module: "diagnosis",
      action: { kind: "operations_change", summary: "stale" },
      scenario,
      reversibility: { level: "easy", if_you_change_your_mind: "n/a" },
      expires_at: PAST,
    });
    const summary = await run(s.profile_id);
    expect(summary.expired).toBeGreaterThanOrEqual(1);
    const [row] = await db.select().from(proposals).where(eq(proposals.id, stale.id));
    expect(row?.status).toBe("expired");
    expect(row?.rejection_reason).toBeNull();
  });

  it("a watching-mode profile's due approval is refused by the engine, not run", async () => {
    const s = await fresh();
    await db
      .update(modeDecisions)
      .set({ mode: "watching", watch_weeks: 6 })
      .where(eq(modeDecisions.profile_id, s.profile_id));
    await scheduled(s, { key: "watched", value: "z" });
    const summary = await run(s.profile_id);
    expect(summary.refused).toBe(1);
    expect(summary.outcomes[0]?.detail).toMatch(/^watching:/);
    expect(fixtureRead(s.profile_id, "watched")).toBeUndefined();
  });
});
