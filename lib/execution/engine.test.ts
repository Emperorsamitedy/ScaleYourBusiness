// Session B's done-when, as tests: the fixture provider executes an
// approved proposal exactly once under concurrent retries; unapproved,
// expired and watching-mode executions are refused; a reversible action
// undoes cleanly from its stored payload; the emergency stop kills a
// queued execution mid-flight. No real platform anywhere.

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
import type { ExecutionRefused } from "./engine";
import {
  executeProposal,
  haltExecutions,
  haltState,
  resumeExecutions,
  undoExecution,
} from "./engine";
import {
  fixtureExecuteCalls,
  fixtureExecutor,
  fixtureFailNextAttempts,
  fixtureNotes,
  fixtureRead,
  fixtureReset,
} from "./providers/fixture";

const created: { account_id: string; profile_id: string }[] = [];
const noSleep = async () => undefined;

async function fresh(mode: "instant" | "watching" | "none" = "instant") {
  const s = await bootstrapIntake();
  created.push(s);
  if (mode !== "none") {
    await db.insert(modeDecisions).values({
      profile_id: s.profile_id,
      mode,
      watch_weeks: mode === "watching" ? 6 : null,
      inputs: { reasons: ["test fixture"] },
      reasoning: "test fixture",
      confidence: "0.900",
      review_at: new Date(Date.now() + 42 * 86_400_000).toISOString(),
    });
  }
  const [u] = await db
    .insert(users)
    .values({
      account_id: s.account_id,
      email: `p3-b-${crypto.randomUUID()}@test.local`,
      display_name: "Session B decider",
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

async function approved(
  s: { profile_id: string; user_id: string },
  args: { level?: "easy" | "moderate" | "hard"; executeNotBefore?: string } = {},
): Promise<ProposalRow> {
  const row = await createProposal({
    profile_id: s.profile_id,
    module: "diagnosis",
    action: { kind: "operations_change", summary: "fixture action" },
    scenario,
    reversibility: {
      level: args.level ?? "easy",
      if_you_change_your_mind: "undo restores the previous value",
    },
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
  });
  return approveProposal({
    proposalId: row.id,
    userId: s.user_id,
    executeNotBefore: args.executeNotBefore ?? null,
  });
}

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
  for (const s of created) {
    await db.delete(accounts).where(eq(accounts.id, s.account_id));
  }
});

const run = (proposalId: string, params: Record<string, unknown> = { key: "k", value: "new" }) =>
  executeProposal({
    proposalId,
    provider: fixtureExecutor,
    op: "set_value",
    params,
    sleep: noSleep,
  });

describe("P3-09 — the watching block (step 67)", () => {
  it("a profile in watching mode cannot be written for", async () => {
    const s = await fresh("watching");
    const p = await approved(s);
    await expect(run(p.id)).rejects.toMatchObject({ code: "watching" });
    expect(fixtureExecuteCalls()).toBe(0);
  });

  it("a profile with NO mode decision is blocked too — never cleared, never written", async () => {
    const s = await fresh("none");
    const p = await approved(s);
    await expect(run(p.id)).rejects.toMatchObject({ code: "no_mode_decision" });
    expect(fixtureExecuteCalls()).toBe(0);
  });
});

describe("P3-10 — approved-only, exactly once", () => {
  it("refuses every non-approved status distinctly, executing nothing", async () => {
    const s = await fresh();
    const pending = await createProposal({
      profile_id: s.profile_id,
      module: "diagnosis",
      action: { kind: "operations_change", summary: "pending" },
      scenario,
      reversibility: { level: "easy", if_you_change_your_mind: "n/a" },
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    });
    await expect(run(pending.id)).rejects.toMatchObject({ code: "not_approved" });

    const blocked = await createProposal({
      profile_id: s.profile_id,
      module: "diagnosis",
      action: { kind: "discount_or_promotion", summary: "blocked" },
      scenario,
      reversibility: { level: "easy", if_you_change_your_mind: "n/a" },
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      blocked_by_limit: "13.5: never discount",
    });
    await expect(run(blocked.id)).rejects.toThrow(/blocked/);
    expect(fixtureExecuteCalls()).toBe(0);
  });

  it("honours the schedule floor the owner picked", async () => {
    const s = await fresh();
    const p = await approved(s, {
      executeNotBefore: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    });
    await expect(run(p.id)).rejects.toMatchObject({ code: "scheduled_later" });
  });

  it("honours a floor later the same day (instants compared, not Postgres' strings)", async () => {
    // Review 2026-10-23: "2026-10-23 10:00:00+00" sorts below "2026-10-23T09:…"
    // as text, so a same-day floor used to pass. Five minutes ahead stays the
    // same day except in the day's last five minutes, when it still must refuse.
    const s = await fresh();
    const p = await approved(s, {
      executeNotBefore: new Date(Date.now() + 5 * 60_000).toISOString(),
    });
    await expect(run(p.id)).rejects.toMatchObject({ code: "scheduled_later" });
    expect(fixtureExecuteCalls()).toBe(0);
  });

  it("executes an approved proposal, flips it to executed, and a second call changes nothing", async () => {
    const s = await fresh();
    const p = await approved(s);
    const done = await run(p.id);
    expect(done.status).toBe("succeeded");
    expect(fixtureRead(s.profile_id, "k")).toBe("new");
    const [prop] = await db.select().from(proposals).where(eq(proposals.id, p.id));
    expect(prop?.status).toBe("executed");

    const again = await run(p.id);
    expect(again.id).toBe(done.id);
    expect(fixtureExecuteCalls()).toBe(1);
  });

  it("EXACTLY ONCE under a concurrent race — the unique index arbitrates", async () => {
    const s = await fresh();
    const p = await approved(s);
    const results = await Promise.allSettled([run(p.id), run(p.id)]);
    expect(fixtureExecuteCalls()).toBe(1);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    for (const r of results) {
      if (r.status === "rejected") {
        expect((r.reason as ExecutionRefused).code).toBe("in_flight");
      }
    }
  });

  it("an unregistered op does not run, whatever the caller says", async () => {
    const s = await fresh();
    const p = await approved(s);
    await expect(
      executeProposal({
        proposalId: p.id,
        provider: fixtureExecutor,
        op: "drop_all_tables",
        params: {},
        sleep: noSleep,
      }),
    ).rejects.toMatchObject({ code: "unregistered_op" });
  });
});

describe("P3-10/13 — retries, caps, and the attempt journal", () => {
  it("retries under the cap and journals every attempt with its duration", async () => {
    const s = await fresh();
    const p = await approved(s);
    fixtureFailNextAttempts(2);
    const done = await run(p.id);
    expect(done.status).toBe("succeeded");
    expect(done.attempts).toBe(3);
    const rows = await db
      .select()
      .from(executionAttempts)
      .where(eq(executionAttempts.execution_id, done.id));
    expect(rows.map((r) => r.ok).sort()).toEqual([false, false, true]);
    for (const r of rows) {
      expect(r.duration_ms).toBeGreaterThanOrEqual(0);
      expect(r.account_id).toBe(s.account_id);
    }
  });

  it("exhausting the cap fails honestly, and a later re-run resumes and succeeds", async () => {
    const s = await fresh();
    const p = await approved(s);
    fixtureFailNextAttempts(3);
    const failed = await run(p.id);
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("injected failure");
    const [prop] = await db.select().from(proposals).where(eq(proposals.id, p.id));
    expect(prop?.status).toBe("approved"); // still approved — resumable, not lost

    const resumed = await run(p.id);
    expect(resumed.status).toBe("succeeded");
  });

  it("P3-21d: an error marked retryable:false stops the loop at once; an unmarked one spends the cap", async () => {
    const s = await fresh();
    let calls = 0;
    const final = {
      ...fixtureExecutor,
      execute: async () => {
        calls += 1;
        throw Object.assign(new Error("a refusal another attempt would only repeat"), {
          retryable: false,
        });
      },
    };
    const p = await approved(s);
    const stopped = await executeProposal({
      proposalId: p.id,
      provider: final,
      op: "set_value",
      params: { key: "k", value: 1 },
      sleep: noSleep,
    });
    expect(stopped).toMatchObject({ status: "failed", attempts: 1 });
    expect(calls).toBe(1);

    calls = 0;
    const plain = {
      ...final,
      execute: async () => {
        calls += 1;
        throw new Error("transient");
      },
    };
    const q = await approved(s);
    const spent = await executeProposal({
      proposalId: q.id,
      provider: plain,
      op: "set_value",
      params: { key: "k", value: 1 },
      sleep: noSleep,
    });
    expect(spent).toMatchObject({ status: "failed", attempts: 3 });
    expect(calls).toBe(3);
  });
});

describe("Session D — the real-write gate (guard 6a) and the provider's pre-flight (6b)", () => {
  const gateBefore = process.env.SESSION_D_REAL_WRITES;
  afterAll(() => {
    if (gateBefore === undefined) delete process.env.SESSION_D_REAL_WRITES;
    else process.env.SESSION_D_REAL_WRITES = gateBefore;
  });

  it("an external provider is refused unclaimed while the gate is off; the fixtures are not external", async () => {
    delete process.env.SESSION_D_REAL_WRITES;
    const s = await fresh();
    let touched = 0;
    const external = {
      ...fixtureExecutor,
      external: true,
      captureUndo: async () => {
        touched += 1;
        return { k: 1 };
      },
      execute: async () => {
        touched += 1;
        return { ok: true };
      },
    };
    const p = await approved(s);
    const refused = await executeProposal({
      proposalId: p.id,
      provider: external,
      op: "set_value",
      params: { key: "k", value: 1 },
      sleep: noSleep,
    }).catch((e: unknown) => e as ExecutionRefused);
    expect(refused).toMatchObject({ code: "real_writes_off" });
    expect((refused as Error).message).toMatch(/switched off until the two-week unattended test/);
    expect(touched).toBe(0);
    expect(await db.select().from(executions).where(eq(executions.proposal_id, p.id))).toEqual([]);
    const [prop] = await db.select().from(proposals).where(eq(proposals.id, p.id));
    expect(prop?.status).toBe("approved");

    // The fixture, gate off, runs as it always has.
    expect((await run(p.id)).status).toBe("succeeded");

    process.env.SESSION_D_REAL_WRITES = "on";
    const q = await approved(s);
    const done = await executeProposal({
      proposalId: q.id,
      provider: external,
      op: "set_value",
      params: { key: "k", value: 1 },
      sleep: noSleep,
    });
    expect(done.status).toBe("succeeded");
  });

  it("a pre-flight refusal leaves no execution row and the proposal approved; null goes ahead", async () => {
    const s = await fresh();
    const deferring = {
      ...fixtureExecutor,
      preflight: async () => ({ code: "deferred" as const, message: "not now" }),
    };
    const p = await approved(s);
    await expect(
      executeProposal({
        proposalId: p.id,
        provider: deferring,
        op: "set_value",
        params: { key: "k", value: 1 },
        sleep: noSleep,
      }),
    ).rejects.toMatchObject({ code: "deferred", message: "not now" });
    expect(await db.select().from(executions).where(eq(executions.proposal_id, p.id))).toEqual([]);
    const ahead = { ...fixtureExecutor, preflight: async () => null };
    const done = await executeProposal({
      proposalId: p.id,
      provider: ahead,
      op: "set_value",
      params: { key: "k", value: 2 },
      sleep: noSleep,
    });
    expect(done.status).toBe("succeeded");
  });
});

describe("P3-11 — the rollback store (rule 16)", () => {
  it("captures the undo BEFORE executing and restores the previous value months later", async () => {
    const s = await fresh();
    const seed = await approved(s);
    await run(seed.id, { key: "price", value: "old" });

    const p = await approved(s);
    const done = await run(p.id, { key: "price", value: "new" });
    expect(fixtureRead(s.profile_id, "price")).toBe("new");
    expect(done.undo_payload).toMatchObject({ key: "price", previous: "old" });

    const undone = await undoExecution({
      executionId: done.id,
      provider: fixtureExecutor,
      userId: s.user_id,
    });
    expect(undone.status).toBe("undone");
    expect(fixtureRead(s.profile_id, "price")).toBe("old");

    await expect(
      undoExecution({ executionId: done.id, provider: fixtureExecutor, userId: s.user_id }),
    ).rejects.toThrow(/already undone/);
  });

  it("P3-20a: undo resolves the provider from the execution row itself, and refuses a mismatched one", async () => {
    const s = await fresh();
    const p = await approved(s);
    const done = await run(p.id, { key: "colour", value: "ember" });
    expect(done.provider).toBe("fixture");

    // The wrong provider is refused by name — never trusted over the row.
    await expect(
      undoExecution({
        executionId: done.id,
        provider: { ...fixtureExecutor, id: "fixture_site" },
        userId: s.user_id,
      }),
    ).rejects.toMatchObject({ code: "not_undoable", status: 422 });
    expect(fixtureRead(s.profile_id, "colour")).toBe("ember");

    // No provider passed: resolved from executions.provider.
    const undone = await undoExecution({ executionId: done.id, userId: s.user_id });
    expect(undone.status).toBe("undone");
    expect(fixtureRead(s.profile_id, "colour")).toBeUndefined();
  });

  it("an op with no undo must have been labelled 'hard' before approval — else it never runs", async () => {
    const s = await fresh();
    const lied = await approved(s, { level: "easy" });
    await expect(
      executeProposal({
        proposalId: lied.id,
        provider: fixtureExecutor,
        op: "append_note",
        params: { note: "x" },
        sleep: noSleep,
      }),
    ).rejects.toMatchObject({ code: "reversibility_lie" });
    expect(fixtureNotes(s.profile_id)).toEqual([]);

    const honest = await approved(s, { level: "hard" });
    const done = await executeProposal({
      proposalId: honest.id,
      provider: fixtureExecutor,
      op: "append_note",
      params: { note: "x" },
      sleep: noSleep,
    });
    expect(done.status).toBe("succeeded");
    await expect(
      undoExecution({ executionId: done.id, provider: fixtureExecutor, userId: s.user_id }),
    ).rejects.toMatchObject({ code: "not_undoable" });
  });
});

describe("P3-12 — the emergency stop (rule 15)", () => {
  it("halted before start: nothing moves until resume", async () => {
    const s = await fresh();
    const p = await approved(s);
    await haltExecutions({ accountId: s.account_id, userId: s.user_id, reason: "test" });
    await expect(run(p.id)).rejects.toMatchObject({ code: "halted" });
    expect(fixtureExecuteCalls()).toBe(0);

    await resumeExecutions(s.account_id);
    const done = await run(p.id);
    expect(done.status).toBe("succeeded");
  });

  it("the stop reports its own state — who stopped it, when, and why", async () => {
    const s = await fresh();
    expect(await haltState(s.account_id)).toMatchObject({ halted: false, halted_at: null });

    await haltExecutions({
      accountId: s.account_id,
      userId: s.user_id,
      reason: "prices look wrong",
    });
    const halted = await haltState(s.account_id);
    expect(halted.halted).toBe(true);
    expect(halted.halted_by).toBe(s.user_id);
    expect(halted.reason).toBe("prices look wrong");
    expect(halted.halted_at).not.toBeNull();

    // Stopping twice keeps the FIRST stop's record — the original
    // reason and moment survive a panicked second click.
    await haltExecutions({ accountId: s.account_id, userId: null, reason: "again" });
    const again = await haltState(s.account_id);
    expect(again.reason).toBe("prices look wrong");
    expect(again.halted_at).toBe(halted.halted_at);

    await resumeExecutions(s.account_id);
    expect(await haltState(s.account_id)).toMatchObject({ halted: false, reason: null });
  });

  it("halted MID-FLIGHT: the stop lands between attempts and the loop dies", async () => {
    const s = await fresh();
    const p = await approved(s);
    fixtureFailNextAttempts(1);
    // The injectable backoff is where the halt lands "while in flight".
    const haltDuringBackoff = async () => {
      await haltExecutions({ accountId: s.account_id, reason: "mid-flight test" });
    };
    await expect(
      executeProposal({
        proposalId: p.id,
        provider: fixtureExecutor,
        op: "set_value",
        params: { key: "k", value: "v" },
        sleep: haltDuringBackoff,
      }),
    ).rejects.toMatchObject({ code: "halted" });
    expect(fixtureExecuteCalls()).toBe(1); // attempt two never ran
    const [row] = await db.select().from(executions).where(eq(executions.proposal_id, p.id));
    expect(row?.status).toBe("failed");
    expect(row?.error).toContain("halted");
    await resumeExecutions(s.account_id);
  });
});
