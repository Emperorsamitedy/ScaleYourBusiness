// The fixture executor — Session B's proving ground. An in-memory
// store, no network, no external account: every engine guard is proven
// against this before any real platform sees a write (the Phase 2
// order — fixture first, Stripe second).
//
// Test hooks are explicit: failNextAttempts makes execute throw N times
// (retry and halt tests), and the call counter is how the idempotency
// test proves "exactly once" rather than assuming it.

import type { ExecutionProviderId } from "../scopes";
import type { ApprovalView } from "../stale";

export interface ExecutionContext {
  profile_id: string;
  account_id: string;
  /** The engine's executions row for this run (P3-21d) — the publish path's handle. Unset for undo. */
  execution_id?: string;
  /** P3-24d: which attempt of the engine's loop this is (1-based). Unset outside execute. */
  attempt?: number;
  /**
   * P3-24c: is the emergency stop on right now? Supplied by the engine, so a
   * provider with several steps (a carousel's children, then its parent,
   * then media_publish) checks between them and refuses before the step
   * that makes anything public. Unset outside execute.
   */
  halted?: () => Promise<boolean>;
  /**
   * Undo only: the stored result of the execution being undone — what it
   * actually set, so an undo can refuse when the live value has moved since
   * (review 2026-10-23, Session D #4). Unset outside undo.
   */
  result?: unknown;
}

/**
 * P3-24b/c: an error a provider throws when the run must WAIT rather than
 * end — `held_for` names what it waits for. "reconnect": the connection
 * failed authentication and paused itself; "stop": the emergency stop came
 * on before anything was sent. The engine journals the run as failed with
 * that hold, and the due runner picks it up again once the cause clears.
 * P4-15 adds "remaining": a campaign run ended at its per-run recipient
 * cap (or the email service asked it to slow down) with recipients still
 * unsent; the next run sends only those.
 */
export type HeldFor = "reconnect" | "stop" | "remaining";

/** Pure: the hold an error carries, or null. */
export function heldFor(error: unknown): HeldFor | null {
  if (error === null || typeof error !== "object") return null;
  const v = (error as { held_for?: unknown }).held_for;
  return v === "reconnect" || v === "stop" || v === "remaining" ? v : null;
}

/**
 * Review 2026-10-23 (#16): a hold may also say how long to wait before the
 * next run may start — `retry_after_ms` on the error. The engine turns it
 * into executions.held_until; the due runner skips the run until then and
 * the engine refuses an earlier resume, unclaimed. Null = no wait.
 */
export function holdRetryAfterMs(error: unknown): number | null {
  if (error === null || typeof error !== "object") return null;
  const v = (error as { retry_after_ms?: unknown }).retry_after_ms;
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : null;
}

/**
 * A provider's own pre-flight verdict (P3-21d): checked by the engine
 * AFTER every guard and BEFORE the idempotency claim, so a refusal here
 * leaves no execution row and the proposal stays approved for the next
 * run. "deferred" = not now (a rate limit); "refused" = not as things
 * stand (the item changed, the connection is paused).
 */
export interface PreflightRefusal {
  code: "deferred" | "refused";
  message: string;
}

/**
 * What an execution provider is to the engine: capture the undo BEFORE
 * executing, execute, undo from the captured payload. Nothing else —
 * guards, journaling, idempotency and retries all live in the engine,
 * once, not per provider.
 */
export interface ExecutionProvider {
  id: ExecutionProviderId;
  /**
   * True for a provider that writes to a REAL platform (Meta). The engine
   * refuses every one of its ops while the Session D real-write gate is
   * off (lib/env.ts, sessionDRealWritesOn). The fixtures leave it unset.
   */
  readonly external?: boolean;
  /** Optional; null = go ahead. Reads only — nothing here may write. */
  preflight?(
    op: string,
    params: Record<string, unknown>,
    ctx: ExecutionContext,
  ): Promise<PreflightRefusal | null>;
  /** null = this op cannot be undone (must be labelled before approval). */
  captureUndo(
    op: string,
    params: Record<string, unknown>,
    ctx: ExecutionContext,
  ): Promise<unknown | null>;
  execute(op: string, params: Record<string, unknown>, ctx: ExecutionContext): Promise<unknown>;
  undo(op: string, undoPayload: unknown, ctx: ExecutionContext): Promise<unknown>;
  /**
   * Optional, pure: would undoing this execution INCREASE spend (re-activate
   * a paused campaign, put a lowered budget back up)? The engine holds such
   * an undo to the real-write gate (guard 6a); an undo that lowers spend or
   * removes a post stays allowed with the gate off, since it is a safety
   * action (review 2026-10-23, Session D #4).
   */
  undoRaisesSpend?(op: string, undoPayload: unknown, result: unknown): boolean;
  /**
   * Optional, reads only: the owner's sentence when this approval has gone
   * stale (a post far past its time, an ad change on old numbers), else
   * null. The engine checks it before the real-write gate and the claim, and
   * expires the proposal (review 2026-10-23, Session D #1).
   */
  staleApproval?(
    op: string,
    params: Record<string, unknown>,
    ctx: ExecutionContext,
    approval: ApprovalView & { now: Date },
  ): Promise<string | null>;
  /** Optional: the provider's own state for an approval that lapsed (an item, its media). */
  lapsed?(
    op: string,
    params: Record<string, unknown>,
    ctx: ExecutionContext,
    sentence: string,
  ): Promise<void>;
}

/** profile_id → key → value. Module-level: tests read what "the platform" holds. */
const store = new Map<string, Map<string, unknown>>();
const notes = new Map<string, string[]>();

let executeCalls = 0;
let failNext = 0;

function bucket(profileId: string): Map<string, unknown> {
  const existing = store.get(profileId);
  if (existing) return existing;
  const fresh = new Map<string, unknown>();
  store.set(profileId, fresh);
  return fresh;
}

export const fixtureExecutor: ExecutionProvider = {
  id: "fixture",

  async captureUndo(op, params, ctx) {
    if (op === "set_value") {
      const key = String(params.key);
      const values = bucket(ctx.profile_id);
      return { key, previous: values.has(key) ? values.get(key) : null, existed: values.has(key) };
    }
    return null; // append_note cannot be unwritten
  },

  async execute(op, params, ctx) {
    executeCalls += 1;
    if (failNext > 0) {
      failNext -= 1;
      throw new Error("fixture: injected failure");
    }
    if (op === "set_value") {
      bucket(ctx.profile_id).set(String(params.key), params.value);
      return { set: String(params.key) };
    }
    if (op === "append_note") {
      const list = notes.get(ctx.profile_id) ?? [];
      list.push(String(params.note));
      notes.set(ctx.profile_id, list);
      return { notes: list.length };
    }
    throw new Error(`fixture: unknown op "${op}"`);
  },

  async undo(op, undoPayload, ctx) {
    if (op !== "set_value") throw new Error(`fixture: "${op}" has no undo`);
    const { key, previous, existed } = undoPayload as {
      key: string;
      previous: unknown;
      existed: boolean;
    };
    const values = bucket(ctx.profile_id);
    if (existed) values.set(key, previous);
    else values.delete(key);
    return { restored: key };
  },
};

/* ── test hooks ── */

export function fixtureRead(profileId: string, key: string): unknown {
  return store.get(profileId)?.get(key);
}

export function fixtureNotes(profileId: string): readonly string[] {
  return notes.get(profileId) ?? [];
}

export function fixtureFailNextAttempts(n: number): void {
  failNext = n;
}

export function fixtureExecuteCalls(): number {
  return executeCalls;
}

export function fixtureReset(): void {
  store.clear();
  notes.clear();
  executeCalls = 0;
  failNext = 0;
}
