// The sync runner — P2-06.
//
// For every connected connection: take a per-connection lock, pull pages
// from the provider until it says done (or the page cap trips), persist
// each page WITH its cursor in one transaction, then derive the monthly
// facts. A run that dies mid-backfill leaves the cursor at the last page
// that landed, and the next run continues from there — resumability is a
// property of the page loop, not of any provider.
//
// Locking: a Postgres session-level advisory lock, held on a dedicated
// pool client for the duration of the run. If the process is killed the
// session dies and the lock goes with it — no lease column to expire, no
// stale lock to clear by hand. Two cron hits overlapping on the same
// connection: the second sees try_lock false and reports "locked".
//
// Failure discipline: every failed run increments failure_count; at
// MAX_CONSECUTIVE_FAILURES the connection is parked as "failed" and left
// alone until an owner resumes it. A success resets the count. Errors are
// stored as text; no code path puts the secret in one.
//
// JOB-QUEUE DECISION (recorded, not assumed): this stays a cron route
// until a real provider's sync demonstrably exceeds serverless limits —
// the criterion is a single connection's run exceeding half the route's
// max duration, measured in connector_syncs.duration_ms. At that point
// BullMQ (CLAUDE.md stack) takes over the loop below; nothing else here
// changes. Until it is measured, a queue is speculation.

import { logSafeError } from "../core/log-safe";
import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import { connections, connectorSyncs } from "../../db/schema";
import type { DeriveOutcome } from "./derive";
import type { AnomalyOutcome } from "../anomaly/detect";
import { detectAnomalies } from "../anomaly/detect";
import { recordSyncActivity } from "./activity";
import { deriveFactsFromObservations } from "./derive";
import { getProvider } from "./registry";
import { decryptSecret } from "./secrets";
import { isProviderId } from "./scopes";
import { upsertObservations } from "./service";

export const MAX_CONSECUTIVE_FAILURES = 5;
/** Hard cap on provider calls per connection per run. A 365-day fixture backfill is 5 pages. */
export const MAX_PAGES_PER_RUN = 50;

export type SyncKind = "backfill" | "incremental";

export interface SyncOutcome {
  connection_id: string;
  account_id: string | null;
  provider: string | null;
  kind: SyncKind | null;
  ok: boolean;
  /** Set when nothing ran, and why. "not_measurement": an execute connection (P3-20b) — never synced. */
  skipped: "locked" | "not_found" | "not_connected" | "not_measurement" | null;
  pages: number;
  observations: number;
  duration_ms: number;
  error: string | null;
  derived: DeriveOutcome[];
  /** P2-22: the nightly anomaly check, run after derivation. */
  anomalies: AnomalyOutcome[];
}

function lockKey(connectionId: string): string {
  return `connector_sync:${connectionId}`;
}

async function withConnectionLock<T>(
  connectionId: string,
  run: () => Promise<T>,
  onLocked: () => T,
): Promise<T> {
  const client = await db.$client.connect();
  try {
    const res = await client.query<{ locked: boolean }>(
      "select pg_try_advisory_lock(hashtext($1)) as locked",
      [lockKey(connectionId)],
    );
    if (res.rows[0]?.locked !== true) return onLocked();
    try {
      return await run();
    } finally {
      await client.query("select pg_advisory_unlock(hashtext($1))", [lockKey(connectionId)]);
    }
  } finally {
    client.release();
  }
}

function errorText(error: unknown): string {
  // Stored and shown: redacted, so a query error's bound values never persist.
  const facts = logSafeError(error);
  return `${facts.error_name}: ${facts.error_message}`;
}

/** Sync one connection. Never throws for provider or data failures — they are recorded. */
export async function syncConnection(connectionId: string, now = new Date()): Promise<SyncOutcome> {
  const startedAt = Date.now();
  const outcome: SyncOutcome = {
    connection_id: connectionId,
    account_id: null,
    provider: null,
    kind: null,
    ok: false,
    skipped: null,
    pages: 0,
    observations: 0,
    duration_ms: 0,
    error: null,
    derived: [],
    anomalies: [],
  };

  return withConnectionLock(
    connectionId,
    async () => {
      const [row] = await db.select().from(connections).where(eq(connections.id, connectionId));
      if (!row) {
        outcome.skipped = "not_found";
        return outcome;
      }
      outcome.account_id = row.account_id;
      outcome.provider = row.provider;
      // P3-20b: a write credential is never pulled from. The runner's
      // query already excludes execute rows; this holds for a direct call.
      if (row.purpose !== "measure") {
        outcome.skipped = "not_measurement";
        return outcome;
      }
      if (row.status !== "connected") {
        outcome.skipped = "not_connected";
        return outcome;
      }
      outcome.kind = row.cursor === null ? "backfill" : "incremental";

      try {
        if (!isProviderId(row.provider)) {
          throw new Error(`unknown provider "${row.provider}"`);
        }
        if (row.encrypted_secret === null) {
          throw new Error("no credential at rest — reconnect the provider");
        }
        const provider = getProvider(row.provider);
        const secret = decryptSecret(row.encrypted_secret);

        let cursor = row.cursor;
        let done = false;
        while (!done && outcome.pages < MAX_PAGES_PER_RUN) {
          const page = await provider.pull(secret, cursor, now);
          // Page and cursor land together or not at all.
          await db.transaction(async (tx) => {
            outcome.observations += await upsertObservations(
              row.id,
              row.provider,
              page.observations,
              tx,
            );
            await tx
              .update(connections)
              .set({ cursor: page.cursor })
              .where(eq(connections.id, row.id));
          });
          cursor = page.cursor;
          done = page.done;
          outcome.pages += 1;
        }

        await db
          .update(connections)
          .set({ last_sync_at: now.toISOString(), failure_count: 0, last_error: null })
          .where(eq(connections.id, row.id));
        outcome.ok = true;
        outcome.derived = await deriveFactsFromObservations(row.id);
        // P2-13: one honest line in the watch log, only for real work.
        await recordSyncActivity({
          connectionId: row.id,
          accountId: row.account_id,
          provider: row.provider,
          fromCursor: row.cursor,
          toCursor: cursor,
          derived: outcome.derived,
        });
        // P2-22: the nightly anomaly check. It reads what this run stored;
        // a failure in it must not turn a successful sync into a failed one.
        try {
          outcome.anomalies = await detectAnomalies(row.id, now);
        } catch (error) {
          console.error(
            JSON.stringify({
              event: "anomaly_detection_failed",
              account_id: row.account_id,
              connection_id: row.id,
              message: errorText(error),
            }),
          );
        }
      } catch (error) {
        outcome.error = errorText(error);
        const failures = row.failure_count + 1;
        await db
          .update(connections)
          .set({
            failure_count: failures,
            last_error: outcome.error,
            status: failures >= MAX_CONSECUTIVE_FAILURES ? "failed" : row.status,
          })
          .where(eq(connections.id, row.id));
      }

      outcome.duration_ms = Date.now() - startedAt;
      await recordSync(outcome);
      return outcome;
    },
    () => {
      outcome.skipped = "locked";
      outcome.duration_ms = Date.now() - startedAt;
      return outcome;
    },
  );
}

/** Telemetry: one structured log line and one connector_syncs row per run. Never breaks the run. */
async function recordSync(outcome: SyncOutcome): Promise<void> {
  console.log(
    JSON.stringify({
      event: "connector_sync",
      account_id: outcome.account_id,
      connection_id: outcome.connection_id,
      provider: outcome.provider,
      kind: outcome.kind,
      ok: outcome.ok,
      pages: outcome.pages,
      observations: outcome.observations,
      duration_ms: outcome.duration_ms,
      error: outcome.error,
      derived: outcome.derived.map((d) => `${d.field_key}:${d.outcome}`),
    }),
  );
  if (outcome.account_id === null || outcome.kind === null) return;
  try {
    await db.insert(connectorSyncs).values({
      connection_id: outcome.connection_id,
      account_id: outcome.account_id,
      kind: outcome.kind,
      duration_ms: outcome.duration_ms,
      pages: outcome.pages,
      observations_upserted: outcome.observations,
      ok: outcome.ok,
      error: outcome.error,
    });
  } catch (error) {
    console.error(
      JSON.stringify({ event: "connector_sync_persist_failed", message: errorText(error) }),
    );
  }
}

export interface SyncRunSummary {
  connections: number;
  ok: number;
  failed: number;
  skipped: number;
  observations: number;
}

/** The daily cron's body: every connected connection, one after another. */
export async function runConnectorSync(now = new Date()): Promise<SyncRunSummary> {
  const rows = await db
    .select({ id: connections.id })
    .from(connections)
    .where(and(eq(connections.status, "connected"), eq(connections.purpose, "measure")))
    .orderBy(connections.created_at);
  const summary: SyncRunSummary = {
    connections: rows.length,
    ok: 0,
    failed: 0,
    skipped: 0,
    observations: 0,
  };
  for (const { id } of rows) {
    const outcome = await syncConnection(id, now);
    if (outcome.skipped) summary.skipped += 1;
    else if (outcome.ok) summary.ok += 1;
    else summary.failed += 1;
    summary.observations += outcome.observations;
  }
  return summary;
}
