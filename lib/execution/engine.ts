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
//   3a. staleness (review 2026-10-23, Session D #1) — a provider that can
//      tell (Meta's two) refuses an approval gone stale: a post more than
//      30 hours past its time, an ad change approved more than 14 days ago.
//      The proposal becomes expired with the owner's sentence; nothing sent
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
// Between 6 and 7, two Session D checks (P3-21b/d) that must refuse
// WITHOUT claiming, so the proposal stays approved and nothing burns:
//
//   6a. the real-write gate — a provider that writes to a real platform
//       (provider.external) runs only when SESSION_D_REAL_WRITES=on. Off
//       by default until Phase 2's two-week unattended clock completes
//       (TASKS-PHASE3.md, Session D gate). Nothing is sent, not even a
//       read. The emergency stop (guard 1) still comes first.
//   6b. the provider's own pre-flight (reads only): a rate limit defers,
//       an item that changed since approval refuses.
//
// Then: undo captured BEFORE attempt one and kept forever; a capped
// retry loop with per-attempt journal rows (P3-13); on success the
// proposal flips to executed through the Session A service, which
// writes the decision-log entry in the same transaction.
//
// Session D, layer D5 (P3-24b/c/d):
//
//   - a run that must WAIT rather than end is journaled `failed` with a
//     hold (executions.held_for): "reconnect" when the provider's
//     connection failed authentication and paused itself, "stop" when the
//     emergency stop came on mid-run — at the top of an attempt, or between
//     a provider's own steps (ctx.halted). The due runner picks a held run
//     up again once the cause clears, and the reclaim below re-runs it
//     through EVERY guard above; nothing is skipped because it ran before.
//   - each attempt row carries the rate-limit usage the platform reported
//     on that attempt's own requests (execution_attempts.usage).
//
// Phase 4 Session F (P4-15): campaign email is a provider like Meta's, and
// adds one hold, "remaining" — a campaign run that reached its per-run
// recipient cap, or that the email service asked to slow down, with
// recipients still unsent. Journaled and re-run exactly like the others.

import { logSafeError } from "../core/log-safe";
import { createHash } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "../../db";
import type { DbOrTx } from "../../db";
import {
  businessProfiles,
  decisionLog,
  executionAttempts,
  executionHalts,
  executions,
  proposals,
  watchActivity,
} from "../../db/schema";
import { sessionDRealWritesOn } from "../env";
import { latestDecision } from "../mode/service";
import { recordExecution } from "../proposals/service";
import type { ExecutionProviderId } from "./scopes";
import { EXECUTION_SCOPE_REGISTRY } from "./scopes";
import type { AttemptUsage } from "./attempt-usage";
import { emptyUsage, withUsage } from "./attempt-usage";
import type { ExecutionContext, ExecutionProvider, HeldFor } from "./providers/fixture";
import { heldFor, holdRetryAfterMs } from "./providers/fixture";
import { executionProvider } from "./providers/index";
import { STALE_NOTE } from "./stale";

export const MAX_ATTEMPTS = 3;

/**
 * The real-write gate's refusal, in the owner's words (guard 6a). A provider
 * whose approvals can go stale says what really happens once the gate is on
 * (review 2026-10-23, Session D #1): it goes out only while still timely.
 */
export function realWritesOffSentence(label: string, staleNote?: string): string {
  return `${label} is switched off until the two-week unattended test completes. Nothing was sent; this stays approved. ${staleNote ?? "It goes out on the first run after it is switched on."}`;
}

/** Guard 6a on an undo that would raise spend (review 2026-10-23, Session D #4). */
export function undoRaisesSpendOffSentence(label: string): string {
  return `${label} is switched off until the two-week unattended test completes, and this undo would raise spend again, so I won't make it. Nothing was changed. An undo that lowers spend still works.`;
}

/**
 * A provider marks an error `retryable: false` when another attempt could
 * only repeat it or, worse, repeat a post Meta may already hold (P3-21d).
 * The loop stops there instead of spending the rest of its cap.
 */
function isFinal(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    (error as { retryable?: unknown }).retryable === false
  );
}

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
    | "not_found"
    | "stale"
    | "real_writes_off"
    | "deferred"
    | "preflight_refused";
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
/**
 * I-52d: the stop and its release on the append-only decision log, with the
 * person who pressed it (null for a browser with no sign-in, which may
 * always stop). The halt row is deleted on release, so the log is what
 * keeps who stopped, who started things again, and when. Ids and a hash only.
 */
/** A stop's reference: the account's halt row is keyed by account, so the press is the account and its time. */
const haltRef = (accountId: string, haltedAt: string) =>
  `${accountId}@${new Date(haltedAt).toISOString()}`;

async function logStop(
  executor: DbOrTx,
  accountId: string,
  kind: "stop" | "stop_release",
  ref: string,
  userId: string | null,
  reason: string | null,
): Promise<void> {
  const [profile] = await executor
    .select({ id: businessProfiles.id })
    .from(businessProfiles)
    .where(eq(businessProfiles.account_id, accountId))
    .orderBy(asc(businessProfiles.created_at))
    .limit(1);
  if (!profile) return;
  await executor.insert(decisionLog).values({
    profile_id: profile.id,
    actor: userId ? "owner" : "system",
    kind,
    ref_id: ref,
    user_id: userId,
    payload_hash: createHash("sha256")
      .update(JSON.stringify({ kind, account_id: accountId, ref, user_id: userId, reason }))
      .digest("hex"),
  });
}

export async function haltExecutions(args: {
  accountId: string;
  userId?: string | null;
  reason?: string;
  /** Join the caller's transaction (the chat's confirm). */
  tx?: DbOrTx;
}): Promise<void> {
  const executor = args.tx ?? db;
  const [row] = await executor
    .insert(executionHalts)
    .values({
      account_id: args.accountId,
      halted_by: args.userId ?? null,
      reason: args.reason ?? null,
    })
    .onConflictDoNothing()
    .returning({ halted_at: executionHalts.halted_at });
  // A second press while already stopped changes nothing, so it logs nothing.
  if (row) {
    await logStop(
      executor,
      args.accountId,
      "stop",
      haltRef(args.accountId, row.halted_at),
      args.userId ?? null,
      args.reason ?? null,
    );
  }
}

export async function resumeExecutions(
  accountId: string,
  /** I-52d: the signed-in person starting things again. */
  userId: string | null = null,
): Promise<void> {
  await db.transaction(async (tx) => {
    const released = await tx
      .delete(executionHalts)
      .where(eq(executionHalts.account_id, accountId))
      .returning({ halted_at: executionHalts.halted_at });
    for (const r of released) {
      await logStop(tx, accountId, "stop_release", haltRef(accountId, r.halted_at), userId, null);
    }
  });
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
  // Compared as instants, not strings: Postgres answers "2026-10-23 09:00:00+00",
  // which sorts below any ISO "2026-10-23T…" of the same day (review 2026-10-23).
  if (proposal.execute_not_before && Date.parse(proposal.execute_not_before) > now().getTime()) {
    throw new ExecutionRefused(
      "scheduled_later",
      `approved to run no earlier than ${proposal.execute_not_before.slice(0, 10)}`,
    );
  }

  // Guard 3a — a schedule long past is not a schedule (review 2026-10-23,
  // Session D #1). An approved post far past its time, or an ad change
  // approved on numbers that have since gone stale, is not acted on late:
  // the proposal becomes `expired`, the owner is told in words, and nothing
  // is sent — not even a read. Before the real-write gate, so approvals that
  // waited out the gate, a long stop or a reconnect lapse the same way.
  if (args.provider.staleApproval) {
    const sentence = await args.provider.staleApproval(args.op, args.params, ctx, {
      decided_at: proposal.decided_at,
      execute_not_before: proposal.execute_not_before,
      action: proposal.action,
      now: now(),
    });
    if (sentence !== null) {
      if (await lapseApproval(proposal, sentence, ctx.account_id, now())) {
        await args.provider.lapsed?.(args.op, args.params, ctx, sentence);
      }
      throw new ExecutionRefused("stale", sentence);
    }
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

  // Guard 6a — the real-write gate. Before the claim: no row, nothing sent.
  if (args.provider.external === true && !sessionDRealWritesOn()) {
    console.log(
      JSON.stringify({
        event: "execution_refused",
        account_id: ctx.account_id,
        proposal_id: proposal.id,
        provider: args.provider.id,
        op: args.op,
        code: "real_writes_off",
      }),
    );
    throw new ExecutionRefused(
      "real_writes_off",
      realWritesOffSentence(
        spec?.label ?? args.provider.id,
        args.provider.staleApproval
          ? STALE_NOTE[args.provider.id as keyof typeof STALE_NOTE]
          : undefined,
      ),
    );
  }

  // Guard 6b — the provider's own pre-flight. Reads only; refuses unclaimed.
  if (args.provider.preflight) {
    const refusal = await args.provider.preflight(args.op, args.params, ctx);
    if (refusal) {
      throw new ExecutionRefused(
        refusal.code === "deferred" ? "deferred" : "preflight_refused",
        refusal.message,
      );
    }
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
    // A hold that named a wait (review 2026-10-23, #16) is honoured here too,
    // so no caller (the due runner or a click) resumes it early. Unclaimed.
    if (existing.held_until && Date.parse(existing.held_until) > now().getTime()) {
      throw new ExecutionRefused(
        "deferred",
        `${existing.error ?? "This is waiting before it tries again."} The next try is no earlier than ${new Date(existing.held_until).toISOString().slice(11, 16)} UTC.`,
      );
    }
    // failed → resume: reclaim by flipping failed → running, conditionally.
    // The attempt counter resets — the cap bounds one run, and a
    // deliberate re-run is a new run, not a continuation of the old cap.
    // started_at resets too (review 2026-10-23, #1): it is the run's own
    // start, so the stale-run reclaim measures THIS run, never the first
    // one, and it is the token the terminal updates below match on.
    const [reclaimed] = await db
      .update(executions)
      .set({
        status: "running",
        error: null,
        attempts: 0,
        held_for: null,
        held_until: null,
        started_at: now().toISOString(),
        finished_at: null,
      })
      .where(and(eq(executions.id, existing.id), eq(executions.status, "failed")))
      .returning();
    if (!reclaimed) throw new ExecutionRefused("in_flight", "this proposal is already executing");
    execution = reclaimed;
  }

  const runCtx: ExecutionContext = { ...ctx, execution_id: execution.id };

  // Undo payload BEFORE attempt one (rule 16), kept forever.
  if (opSpec.reversible && execution.undo_payload === null) {
    let undoPayload: unknown;
    try {
      undoPayload = await args.provider.captureUndo(args.op, args.params, runCtx);
    } catch (error) {
      // Nothing has run, and nothing will without its undo. Close the claimed
      // row as failed (never left `running`, which nothing would ever reclaim).
      // A capture refused because the connection paused itself (P3-24b) waits
      // for the reconnect, as an attempt refused the same way would.
      await db
        .update(executions)
        .set({
          status: "failed",
          error: `the undo could not be captured: ${logSafeError(error).error_message}`,
          finished_at: now().toISOString(),
          held_for: heldFor(error) === "reconnect" ? "reconnect" : null,
        })
        .where(ownRun(execution));
      throw error;
    }
    if (undoPayload === null) {
      await db
        .update(executions)
        .set({ status: "failed", error: "undo promised but not capturable" })
        .where(ownRun(execution));
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

  // The attempt loop — halt checked before EVERY attempt (rule 15), and
  // offered to the provider between its own steps (P3-24c).
  let lastError: string;
  let hold: HeldFor | null = null;
  let retryAfter: number | null = null;
  const halted = () => isHalted(ctx.account_id);
  for (let attempt = execution.attempts + 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (await halted()) {
      await holdForStop(execution, attempt - 1, now());
      throw new ExecutionRefused(
        "halted",
        "the emergency stop came on mid-flight — execution halted",
      );
    }
    const started = Date.now();
    // P3-24d: a real platform reports its rate-limit usage on each response;
    // the fixtures have none, so their rows say null rather than "none seen".
    const usage = args.provider.external === true ? emptyUsage() : null;
    const attemptCtx: ExecutionContext = { ...runCtx, attempt, halted };
    const run = () => args.provider.execute(args.op, args.params, attemptCtx);
    let result: unknown;
    try {
      result = await (usage ? withUsage(usage, run) : run());
    } catch (error) {
      lastError = logSafeError(error).error_message;
      await recordAttempt(execution.id, ctx.account_id, attempt, started, false, lastError, usage);
      await db
        .update(executions)
        .set({ attempts: attempt, error: lastError })
        .where(ownRun(execution));
      hold = heldFor(error);
      retryAfter = holdRetryAfterMs(error);
      if (hold === "stop") {
        // The provider saw the stop between its own steps and sent nothing further.
        await holdForStop(execution, attempt, now(), lastError);
        throw new ExecutionRefused(
          "halted",
          "the emergency stop came on mid-flight — execution halted",
        );
      }
      if (hold !== null || isFinal(error)) break;
      if (attempt < MAX_ATTEMPTS) await sleep(200 * attempt);
      continue;
    }
    await recordAttempt(execution.id, ctx.account_id, attempt, started, true, null, usage);
    // The success, and the proposal's flip to executed, in ONE transaction —
    // and only for the run that still owns the row (review 2026-10-23, #1).
    // Outside the try: a failure to record never re-runs a write that happened.
    const done = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(executions)
        .set({
          status: "succeeded",
          attempts: attempt,
          result: sql`${JSON.stringify(result ?? null)}::jsonb`,
          finished_at: now().toISOString(),
          error: null,
        })
        .where(ownRun(execution))
        .returning();
      if (!row) return null;
      await recordExecution({ proposalId: proposal.id, result }, tx);
      return row;
    });
    if (!done) throw lostRun(execution, ctx.account_id);
    return done;
  }

  const [failed] = await db
    .update(executions)
    .set({
      status: "failed",
      finished_at: now().toISOString(),
      held_for: hold,
      held_until:
        hold !== null && retryAfter !== null
          ? new Date(now().getTime() + retryAfter).toISOString()
          : null,
    })
    .where(ownRun(execution))
    .returning();
  if (!failed) throw lostRun(execution, ctx.account_id);
  return failed;
}

/**
 * Guard 3a's write: approved → expired, conditionally, carrying the owner's
 * sentence in execution_result (the engine is that column's one writer), and
 * one watch-log line. decided_by and decided_at stay, so every screen can
 * tell "approved, then lapsed" from "ran out of time undecided". No
 * decision-log row, as for any expiry: it is the absence of an execution.
 * False when the row had already moved on (another run, a click).
 */
async function lapseApproval(
  proposal: { id: string; profile_id: string },
  sentence: string,
  accountId: string,
  at: Date,
): Promise<boolean> {
  const flipped = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(proposals)
      .set({
        status: "expired",
        execution_result: sql`${JSON.stringify({ lapsed: true, at: at.toISOString(), sentence })}::jsonb`,
      })
      .where(and(eq(proposals.id, proposal.id), eq(proposals.status, "approved")))
      .returning({ id: proposals.id });
    if (!row) return false;
    await tx.insert(watchActivity).values({
      profile_id: proposal.profile_id,
      kind: "approval_lapsed",
      detail: sentence,
      meta: { proposal_id: proposal.id },
    });
    return true;
  });
  console.log(
    JSON.stringify({
      event: "approval_lapsed",
      account_id: accountId,
      proposal_id: proposal.id,
      flipped,
    }),
  );
  return flipped;
}

/**
 * The row this run owns: still `running`, and started when this run started.
 * A run the stale reclaim closed (and another run then resumed) no longer
 * matches, so its late terminal update changes nothing — a `succeeded` row,
 * or another run's `running` one, is never overwritten (review 2026-10-23, #1).
 */
function ownRun(execution: Pick<ExecutionRow, "id" | "started_at">) {
  return and(
    eq(executions.id, execution.id),
    eq(executions.status, "running"),
    eq(executions.started_at, execution.started_at),
  );
}

/** This run lost its row (reclaimed, then resumed elsewhere): it says so and writes nothing. */
function lostRun(execution: Pick<ExecutionRow, "id">, accountId: string): ExecutionRefused {
  console.warn(
    JSON.stringify({
      event: "execution_run_lost",
      account_id: accountId,
      execution_id: execution.id,
    }),
  );
  return new ExecutionRefused(
    "in_flight",
    "another run took this over while it was still going; it carries on from there",
  );
}

/** P3-24c: the stop came on mid-run. Failed and held for the resume — never left `running`. */
async function holdForStop(
  execution: Pick<ExecutionRow, "id" | "started_at">,
  attempts: number,
  at: Date,
  error = "halted by the emergency stop",
): Promise<void> {
  await db
    .update(executions)
    .set({ status: "failed", error, attempts, finished_at: at.toISOString(), held_for: "stop" })
    .where(ownRun(execution));
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
    // What this execution actually set: the undo refuses when the live value has moved since.
    result: execution.result,
  };
  if (await isHalted(ctx.account_id)) {
    throw new ExecutionRefused("halted", "the emergency stop is on — resume before undoing");
  }
  // The Session D real-write gate (guard 6a) applies to an undo only when the
  // undo would INCREASE spend — re-activating a campaign SYB paused, or
  // putting a lowered budget back up (review 2026-10-23, Session D #4). An
  // undo that lowers spend or removes a post is a safety action and stays
  // allowed with the gate off: refusing it would keep up a post or a spend
  // the owner wants gone. The stop above applies to every undo.
  if (
    provider.external === true &&
    !sessionDRealWritesOn() &&
    (provider.undoRaisesSpend?.(execution.op, execution.undo_payload, execution.result) ?? false)
  ) {
    const label =
      EXECUTION_SCOPE_REGISTRY[provider.id as ExecutionProviderId]?.label ?? provider.id;
    throw new ExecutionRefused("real_writes_off", undoRaisesSpendOffSentence(label));
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
  usage: AttemptUsage | null,
): Promise<void> {
  await db.insert(executionAttempts).values({
    execution_id: executionId,
    account_id: accountId,
    attempt,
    duration_ms: Date.now() - startedMs,
    ok,
    error,
    usage: usage === null ? null : sql`${JSON.stringify(usage)}::jsonb`,
  });
  console.log(
    JSON.stringify({
      event: "execution_attempt",
      account_id: accountId,
      execution_id: executionId,
      attempt,
      ok,
      ...(error ? { error } : {}),
      ...(usage ? { usage_pct: usage.max_pct, requests: usage.requests.length } : {}),
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
