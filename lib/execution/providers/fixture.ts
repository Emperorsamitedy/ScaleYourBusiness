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
