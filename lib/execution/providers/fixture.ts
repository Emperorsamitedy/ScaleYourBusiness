// The fixture executor — Session B's proving ground. An in-memory
// store, no network, no external account: every engine guard is proven
// against this before any real platform sees a write (the Phase 2
// order — fixture first, Stripe second).
//
// Test hooks are explicit: failNextAttempts makes execute throw N times
// (retry and halt tests), and the call counter is how the idempotency
// test proves "exactly once" rather than assuming it.

import type { ExecutionProviderId } from "../scopes";

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
