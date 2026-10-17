// The execution engine — Phase 3 Session B (P3-09..13).
//
// ONE entry point, and every guard lives inside it, in order, so no
// future call site can skip one:
//
//   1. the emergency stop (rule 15) — checked here AND before every
//      attempt inside the retry loop, so a halt lands mid-flight
//   2. the proposal's status — only "approved" executes; pending,
//      rejected, blocked, expired and executed each refuse distinctly
//   3. the schedule floor — execute_not_before is honoured (P3-05)
//   4. the watching block (P3-09, step 67) — a profile in watching
//      mode, or with NO mode decision at all, cannot be written for.
//      "This test protects a real business from you."
//   5. the operation registry — an op the scope registry doesn't
//      declare does not run, whatever the caller says
//   6. reversibility honesty (P3-11) — an op with no undo must have
//      been labelled irreversible ("hard") before approval; a promised
//      undo that cannot be captured aborts BEFORE anything executes
//   7. idempotency (P3-10, rule 16) — one executions row per proposal,
//      held by a unique index; the losing racer reads, never runs
//
// Then: undo captured BEFORE attempt one and kept forever; a capped
// retry loop with per-attempt journal rows (P3-13); on success the
// proposal flips to executed through the Session A service, which
// writes the decision-log entry in the same transaction.

import { logSafeError } from "../core/log-safe";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../../db";
import { executionAttempts, executionHalts, executions, proposals } from "../../db/schema";
import { latestDecision } from "../mode/service";
import { recordExecution } from "../proposals/service";
import type { ExecutionProviderId } from "./scopes";
import { EXECUTION_SCOPE_REGISTRY } from "./scopes";
import type { ExecutionContext, ExecutionProvider } from "./providers/fixture";
import { executionProvider } from "./providers/index";

export const MAX_ATTEMPTS = 3;

export class ExecutionRefused extends Error {
  readonly code:
    | "halted"
    | "not_approved"
    | "scheduled_later"
    | "watching"
    | "no_mode_decision"
    | "unregistered_op"
    | "reversibility_lie"
    | "in_flight"
    | "not_undoable"
    | "not_found";
  readonly status: number;
  constructor(code: ExecutionRefused["code"], message: string, status = 409) {
    super(message);
    this.name = "ExecutionRefused";
    this.code = code;
    this.status = status;
  }
}

export type ExecutionRow = typeof executions.$inferSelect;

async function isHalted(accountId: string): Promise<boolean> {
  const [row] = await db
    .select({ account_id: executionHalts.account_id })
    .from(executionHalts)
    .where(eq(executionHalts.account_id, accountId));
  return row !== undefined;
}

/** The emergency stop — one control, halts everything in flight (rule 15). */
export async function haltExecutions(args: {
  accountId: string;
  userId?: string | null;
  reason?: string;
}): Promise<void> {
  await db
    .insert(executionHalts)
    .values({
      account_id: args.accountId,
      halted_by: args.userId ?? null,
      reason: args.reason ?? null,
    })
    .onConflictDoNothing();
}

export async function resumeExecutions(accountId: string): Promise<void> {
  await db.delete(executionHalts).where(eq(executionHalts.account_id, accountId));
}

export interface HaltState {
  halted: boolean;
  halted_at: string | null;
  halted_by: string | null;
  reason: string | null;
}

/** The stop's own state, for the owner-visible control (rule 15). */
export async function haltState(accountId: string): Promise<HaltState> {
  const [row] = await db
    .select()
    .from(executionHalts)
    .where(eq(executionHalts.account_id, accountId));
  return row
    ? {
        halted: true,
        halted_at: row.halted_at,
        halted_by: row.halted_by,
        reason: row.reason,
      }
    : { halted: false, halted_at: null, halted_by: null, reason: null };
}

export { isHalted };

export interface ExecuteArgs {
  proposalId: string;
  provider: ExecutionProvider;
  op: string;
  params: Record<string, unknown>;
  /** Injectable for tests; real backoff by default. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Execute an approved proposal, exactly once. Returns the executions
 * row (fresh or, when already done, the existing one — calling twice
 * is safe and changes nothing).
 */
export async function executeProposal(args: ExecuteArgs): Promise<ExecutionRow> {
  const sleep = args.sleep ?? defaultSleep;
  const now = args.now ?? (() => new Date());

  const [proposal] = await db.select().from(proposals).where(eq(proposals.id, args.proposalId));
  if (!proposal) throw new ExecutionRefused("not_found", "no such proposal", 404);

  const ctx: ExecutionContext = await contextFor(proposal.profile_id);

  // Guard 1 — the emergency stop, before anything else moves.
  if (await isHalted(ctx.account_id)) {
    throw new ExecutionRefused(
      "halted",
      "the emergency stop is on — nothing executes until you resume",
    );
  }

  // Guard 2 — only an approval executes, and each refusal explains itself.
  if (proposal.status === "executed") {
    const [existing] = await db
      .select()
      .from(executions)
      .where(eq(executions.proposal_id, proposal.id));
    if (existing) return existing;
    throw new ExecutionRefused("not_approved", "already executed, before this engine existed", 409);
  }
  if (proposal.status !== "approved") {
    throw new ExecutionRefused(
      "not_approved",
      `only an approved proposal can execute — this one is ${proposal.status}`,
    );
  }

  // Guard 3 — the schedule the owner set is a floor, not a suggestion.
  if (proposal.execute_not_before && proposal.execute_not_before > now().toISOString()) {
    throw new ExecutionRefused(
      "scheduled_later",
      `approved to run no earlier than ${proposal.execute_not_before.slice(0, 10)}`,
    );
  }

  // Guard 4 — the watching block (step 67). No decision is also a block:
  // a profile the mode rule has never cleared does not get written for.
  const decision = await latestDecision(proposal.profile_id);
  if (!decision) {
    throw new ExecutionRefused(
      "no_mode_decision",
      "no mode decision on record — nothing executes before one",
    );
  }
  if (decision.mode === "watching") {
    throw new ExecutionRefused(
      "watching",
      "this business is being watched, not changed — the watch blocks every write until it ends",
    );
  }

  // Guard 5 — the op must be in the scope registry's closed set.
  const spec = EXECUTION_SCOPE_REGISTRY[args.provider.id as ExecutionProviderId];
  const opSpec = spec?.operations.find((o) => o.op === args.op);
  if (!opSpec) {
    throw new ExecutionRefused(
      "unregistered_op",
      `"${args.op}" is not a registered operation for ${args.provider.id}`,
    );
  }

  // Guard 6 — reversibility honesty, before anything runs.
  const claimed = (proposal.reversibility as { level?: string } | null)?.level;
  if (!opSpec.reversible && claimed !== "hard") {
    throw new ExecutionRefused(
      "reversibility_lie",
      `"${args.op}" cannot be undone, but the proposal was labelled "${claimed ?? "unknown"}" — irreversible actions are labelled before approval, not discovered after`,
    );
  }

  // Guard 7 — the idempotency claim. The unique index arbitrates.
  const [claimedRow] = await db
    .insert(executions)
    .values({
      proposal_id: proposal.id,
      profile_id: proposal.profile_id,
      account_id: ctx.account_id,
      provider: args.provider.id,
      op: args.op,
    })
    .onConflictDoNothing()
    .returning();

  let execution: ExecutionRow;
  if (claimedRow) {
    execution = claimedRow;
  } else {
    const [existing] = await db
      .select()
      .from(executions)
      .where(eq(executions.proposal_id, proposal.id));
    if (!existing) throw new ExecutionRefused("in_flight", "the execution vanished mid-claim", 500);
    if (existing.status === "succeeded" || existing.status === "undone") return existing;
    if (existing.status === "running") {
      throw new ExecutionRefused("in_flight", "this proposal is already executing");
    }
    // failed → resume: reclaim by flipping failed → running, conditionally.
    // The attempt counter resets — the cap bounds one run, and a
    // deliberate re-run is a new run, not a continuation of the old cap.
    const [reclaimed] = await db
      .update(executions)
      .set({ status: "running", error: null, attempts: 0 })
      .where(and(eq(executions.id, existing.id), eq(executions.status, "failed")))
      .returning();
    if (!reclaimed) throw new ExecutionRefused("in_flight", "this proposal is already executing");
    execution = reclaimed;
  }

  // Undo payload BEFORE attempt one (rule 16), kept forever.
  if (opSpec.reversible && execution.undo_payload === null) {
    const undoPayload = await args.provider.captureUndo(args.op, args.params, ctx);
    if (undoPayload === null) {
      await db
        .update(executions)
        .set({ status: "failed", error: "undo promised but not capturable" })
        .where(eq(executions.id, execution.id));
      throw new ExecutionRefused(
        "reversibility_lie",
        "the undo this op promises could not be captured — refusing to run without it",
      );
    }
    await db
      .update(executions)
      .set({ undo_payload: sql`${JSON.stringify(undoPayload)}::jsonb` })
      .where(eq(executions.id, execution.id));
  }

  // The attempt loop — halt checked before EVERY attempt (rule 15).
  let lastError: string;
  for (let attempt = execution.attempts + 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (await isHalted(ctx.account_id)) {
      await db
        .update(executions)
        .set({ status: "failed", error: "halted by the emergency stop", attempts: attempt - 1 })
        .where(eq(executions.id, execution.id));
      throw new ExecutionRefused(
        "halted",
        "the emergency stop came on mid-flight — execution halted",
      );
    }
    const started = Date.now();
    try {
      const result = await args.provider.execute(args.op, args.params, ctx);
      await recordAttempt(execution.id, ctx.account_id, attempt, started, true, null);
      await recordExecution({ proposalId: proposal.id, result });
      const [done] = await db
        .update(executions)
        .set({
          status: "succeeded",
          attempts: attempt,
          result: sql`${JSON.stringify(result ?? null)}::jsonb`,
          finished_at: now().toISOString(),
          error: null,
        })
        .where(eq(executions.id, execution.id))
        .returning();
      return done as ExecutionRow;
    } catch (error) {
      lastError = logSafeError(error).error_message;
      await recordAttempt(execution.id, ctx.account_id, attempt, started, false, lastError);
      await db
        .update(executions)
        .set({ attempts: attempt, error: lastError })
        .where(eq(executions.id, execution.id));
      if (attempt < MAX_ATTEMPTS) await sleep(200 * attempt);
    }
  }

  const [failed] = await db
    .update(executions)
    .set({ status: "failed", finished_at: now().toISOString() })
    .where(eq(executions.id, execution.id))
    .returning();
  return failed as ExecutionRow;
}

/**
 * Undo a succeeded execution — through the SAME fence: the halt and the
 * watching block apply to undo like any other write, the transition is
 * a conditional update (idempotent), and the decision log records who.
 */
export async function undoExecution(args: {
  executionId: string;
  /**
   * Resolved from the execution's own provider id when omitted (P3-20a).
   * Passing one is for tests and for callers that already hold it; a
   * mismatch with the row is refused rather than trusted.
   */
  provider?: ExecutionProvider;
  /** null = the SYSTEM undid it (auto-rollback, P3-33) — logged as such. */
  userId: string | null;
  /** Ownership scope: when set, only this profile's executions undo. */
  expectedProfileId?: string;
}): Promise<ExecutionRow> {
  const [execution] = await db.select().from(executions).where(eq(executions.id, args.executionId));
  if (!execution) throw new ExecutionRefused("not_found", "no such execution", 404);
  // Ownership clause (2026-09-26 review): foreign = missing — 404,
  // never confirmation of existence across the boundary.
  if (args.expectedProfileId && execution.profile_id !== args.expectedProfileId) {
    throw new ExecutionRefused("not_found", "no such execution", 404);
  }
  if (args.provider && args.provider.id !== execution.provider) {
    throw new ExecutionRefused(
      "not_undoable",
      `this execution ran on ${execution.provider}, not ${args.provider.id} — undo goes through the provider that did it`,
      422,
    );
  }
  const provider = args.provider ?? executionProvider(execution.provider);

  const ctx: ExecutionContext = {
    profile_id: execution.profile_id,
    account_id: execution.account_id,
  };
  if (await isHalted(ctx.account_id)) {
    throw new ExecutionRefused("halted", "the emergency stop is on — resume before undoing");
  }
  // The watching block applies to undo like any other write (the comment
  // above said so; the code didn't check — security review 2026-10-17).
  const decision = await latestDecision(ctx.profile_id);
  if (decision?.mode === "watching") {
    throw new ExecutionRefused(
      "watching",
      "this business is being watched, not changed — the watch blocks every write, undo included",
    );
  }
  if (execution.undo_payload === null) {
    throw new ExecutionRefused(
      "not_undoable",
      "this action was labelled irreversible before you approved it — there is no undo",
    );
  }
  if (execution.status !== "succeeded") {
    throw new ExecutionRefused(
      "not_undoable",
      execution.status === "undone"
        ? "already undone"
        : `cannot undo a ${execution.status} execution`,
    );
  }

  await provider.undo(execution.op, execution.undo_payload, ctx);

  const [row] = await db
    .update(executions)
    .set({ status: "undone", undone_at: new Date().toISOString(), undone_by: args.userId })
    .where(and(eq(executions.id, execution.id), eq(executions.status, "succeeded")))
    .returning();
  if (!row) throw new ExecutionRefused("not_undoable", "already undone");

  const { hashProposalPayload } = await import("../proposals/service");
  const { decisionLog } = await import("../../db/schema");
  await db.insert(decisionLog).values({
    profile_id: execution.profile_id,
    actor: args.userId ? "owner" : "system",
    kind: "execution",
    ref_id: execution.proposal_id,
    payload_hash: hashProposalPayload("execution", {
      proposal_id: execution.proposal_id,
      profile_id: execution.profile_id,
      status: "undone",
      decided_by: args.userId,
      detail: { undone: true, execution_id: execution.id },
    }),
  });
  return row;
}

async function recordAttempt(
  executionId: string,
  accountId: string,
  attempt: number,
  startedMs: number,
  ok: boolean,
  error: string | null,
): Promise<void> {
  await db.insert(executionAttempts).values({
    execution_id: executionId,
    account_id: accountId,
    attempt,
    duration_ms: Date.now() - startedMs,
    ok,
    error,
  });
  console.log(
    JSON.stringify({
      event: "execution_attempt",
      account_id: accountId,
      execution_id: executionId,
      attempt,
      ok,
      ...(error ? { error } : {}),
    }),
  );
}

async function contextFor(profileId: string): Promise<ExecutionContext> {
  const { businessProfiles } = await import("../../db/schema");
  const [row] = await db
    .select({ account_id: businessProfiles.account_id })
    .from(businessProfiles)
    .where(eq(businessProfiles.id, profileId));
  if (!row) throw new ExecutionRefused("not_found", "no such profile", 404);
  return { profile_id: profileId, account_id: row.account_id };
}
