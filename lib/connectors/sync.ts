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
import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { db } from "../../db";
import { withAdvisoryLock } from "../../db/advisory-lock";
import { connections, connectorSyncs, metricObservations } from "../../db/schema";
import type { Provider } from "./provider";
import { TooManyCartsError } from "./provider";
import type { DeriveOutcome } from "./derive";
import type { AnomalyOutcome } from "../anomaly/detect";
import type { MetaReadback } from "../execution/providers/meta";
import { detectAnomalies } from "../anomaly/detect";
import { recordSyncActivity } from "./activity";
import { deriveFactsFromObservations } from "./derive";
import { BOOKINGS_IMPORT_PROVIDER } from "../bookings/source";
import { replaceBaskets } from "../bundles/store";
import { CARTS } from "../carts/measure";
import { storeCarts } from "../carts/store";
import { deriveBookingFacts, storeAppointments } from "../bookings/store";
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
  /**
   * Set when nothing ran, and why. "not_measurement": an execute connection
   * (P3-20b) — never synced. "imported": a bookings import source
   * (specs/bookings.md) — the owner hands its data over; there is nothing to pull.
   */
  skipped: "locked" | "not_found" | "not_connected" | "not_measurement" | "imported" | null;
  pages: number;
  observations: number;
  duration_ms: number;
  error: string | null;
  derived: DeriveOutcome[];
  /** P2-22: the nightly anomaly check, run after derivation. */
  anomalies: AnomalyOutcome[];
  /** Feature 34: the stock snapshot a store provider took, or null (none, or it failed). */
  stock: { observations: number; untracked: number; cost_unknown: number } | null;
  /** Idea 47: the abandoned checkouts a store provider read, or null (none, or it failed). */
  carts: { stored: number; hashed: number; pruned: number } | null;
}

/**
 * Idea 47: read a store's abandoned checkouts. Read-only like every pull,
 * and never fatal: a failed read is logged and the sync stays a success,
 * so the carts screen reads what the last good read stored. The log line
 * carries counts only, never an address.
 */
async function readCarts(
  row: typeof connections.$inferSelect,
  provider: Provider,
  secret: string,
  now: Date,
): Promise<SyncOutcome["carts"]> {
  if (!provider.readAbandonedCheckouts) return null;
  try {
    const read = await provider.readAbandonedCheckouts(secret, now, CARTS.read_days);
    const stored = await storeCarts(row, read, now);
    // Review 2026-10-30: the read's freshness, for the carts screen.
    await db
      .update(connections)
      .set({
        cart_read: {
          ok_at: now.toISOString(),
          failed_at: null,
          too_many: false,
          shopper: read.shopper ?? null,
        },
      })
      .where(eq(connections.id, row.id));
    console.log(
      JSON.stringify({
        event: "carts_read",
        account_id: row.account_id,
        connection_id: row.id,
        provider: row.provider,
        shopper: read.shopper ?? null,
        ...stored,
      }),
    );
    return stored;
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "carts_read_failed",
        account_id: row.account_id,
        connection_id: row.id,
        message: errorText(error),
      }),
    );
    // Review 2026-10-30: kept beside the last good read, never instead of it.
    await db
      .update(connections)
      .set({
        cart_read: {
          ok_at: row.cart_read?.ok_at ?? null,
          failed_at: now.toISOString(),
          too_many: error instanceof TooManyCartsError,
          shopper: row.cart_read?.shopper ?? null,
        },
      })
      .where(eq(connections.id, row.id))
      .catch((e: unknown) =>
        console.error(
          JSON.stringify({
            event: "carts_read_state_failed",
            account_id: row.account_id,
            connection_id: row.id,
            ...logSafeError(e),
          }),
        ),
      );
    return null;
  }
}

/**
 * Feature 34: take a store's stock snapshot. Read-only like every pull, and
 * never fatal: a failed snapshot is logged and the sync stays a success, so
 * the slow-stock screen reads the last snapshot that landed, with its date.
 */
async function readStockSnapshot(
  row: typeof connections.$inferSelect,
  provider: Provider,
  secret: string,
  now: Date,
): Promise<SyncOutcome["stock"]> {
  if (!provider.readStock) return null;
  try {
    const [latest] = await db
      .select({ currency: metricObservations.currency })
      .from(metricObservations)
      .where(
        and(
          eq(metricObservations.connection_id, row.id),
          eq(metricObservations.metric_key, "revenue.daily"),
        ),
      )
      .orderBy(desc(metricObservations.period_date))
      .limit(1);
    const read = await provider.readStock(secret, now, { currency: latest?.currency ?? null });
    const stored = await upsertObservations(row.id, row.provider, read.observations);
    console.log(
      JSON.stringify({
        event: "stock_snapshot",
        account_id: row.account_id,
        connection_id: row.id,
        provider: row.provider,
        observations: stored,
        untracked: read.untracked,
        cost_unknown: read.cost_unknown,
      }),
    );
    return { observations: stored, untracked: read.untracked, cost_unknown: read.cost_unknown };
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "stock_snapshot_failed",
        account_id: row.account_id,
        connection_id: row.id,
        message: errorText(error),
      }),
    );
    return null;
  }
}

function lockKey(connectionId: string): string {
  return `connector_sync:${connectionId}`;
}

/** A session-level advisory lock on a dedicated client; shared with the post readback (P3-23a). */
export { withAdvisoryLock };

function withConnectionLock<T>(
  connectionId: string,
  run: () => Promise<T>,
  onLocked: () => T,
): Promise<T> {
  return withAdvisoryLock(lockKey(connectionId), run, onLocked);
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
    stock: null,
    carts: null,
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
      if (row.provider === BOOKINGS_IMPORT_PROVIDER) {
        outcome.skipped = "imported";
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
          const page = await provider.pull(secret, cursor, now, {
            granted_scopes: row.granted_scopes,
          });
          // Page and cursor land together or not at all.
          await db.transaction(async (tx) => {
            outcome.observations += await upsertObservations(
              row.id,
              row.provider,
              page.observations,
              tx,
            );
            // Idea 48: a store page's order baskets replace those of its days.
            if (page.baskets) {
              await replaceBaskets(tx, row, page.baskets, now.toISOString());
            }
            // Bookings (specs/bookings.md): the page's appointments land with
            // it, client ids hashed on the way in.
            if (page.appointments && page.appointments.length > 0) {
              await storeAppointments(tx, row, page.appointments, {
                batchId: null,
                scope: row.provider,
              });
            }
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
        // Feature 34: a store's stock snapshot, once per run, after the pages.
        outcome.stock = await readStockSnapshot(row, provider, secret, now);
        if (outcome.stock) outcome.observations += outcome.stock.observations;
        // Idea 47: the store's abandoned checkouts, once per run, after the stock.
        outcome.carts = await readCarts(row, provider, secret, now);
        outcome.derived = await deriveFactsFromObservations(row.id);
        // Bookings: the 28-day measures, when this connection reads appointments.
        outcome.derived.push(...(await deriveBookingFacts(row.id, now)));
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

export interface ReadbackRunSummary {
  connections: number;
  ok: number;
  failed: number;
  skipped: number;
  observations: number;
}

export interface SyncRunSummary {
  connections: number;
  ok: number;
  failed: number;
  skipped: number;
  observations: number;
  /**
   * P3-23a: the per-post readback, run by this same cron after the measure
   * connections — reads only, through the execute connection's readback
   * scopes (lib/content/insights.ts). Null when it could not run at all.
   */
  readback: ReadbackRunSummary | null;
}

export interface SyncRunOptions {
  /** The post readback's Meta reads; the real Graph API by default. Tests pass a fake. */
  postReadback?: MetaReadback;
  /**
   * Only these accounts' connections. The cron passes none (every account);
   * tests pass their own, so the run never reaches other rows in a shared
   * database, such as the local demo's fake shops.
   */
  accountIds?: readonly string[];
}

/** The daily cron's body: every connected connection, one after another. */
export async function runConnectorSync(
  now = new Date(),
  opts: SyncRunOptions = {},
): Promise<SyncRunSummary> {
  const rows = await db
    .select({ id: connections.id })
    .from(connections)
    .where(
      and(
        eq(connections.status, "connected"),
        eq(connections.purpose, "measure"),
        ne(connections.provider, BOOKINGS_IMPORT_PROVIDER),
        opts.accountIds ? inArray(connections.account_id, [...opts.accountIds]) : undefined,
      ),
    )
    .orderBy(connections.created_at);
  const summary: SyncRunSummary = {
    connections: rows.length,
    ok: 0,
    failed: 0,
    skipped: 0,
    observations: 0,
    readback: null,
  };
  for (const { id } of rows) {
    const outcome = await syncConnection(id, now);
    if (outcome.skipped) summary.skipped += 1;
    else if (outcome.ok) summary.ok += 1;
    else summary.failed += 1;
    summary.observations += outcome.observations;
  }
  // P3-23a: same runner, reads only. Loaded on use: lib/content sits above
  // this module, and a readback failure never fails the measure sync.
  try {
    const { runPostReadback } = await import("../content/insights");
    summary.readback = await runPostReadback(now, {
      ...(opts.postReadback ? { readback: opts.postReadback } : {}),
      ...(opts.accountIds ? { accountIds: opts.accountIds } : {}),
    });
  } catch (error) {
    console.error(JSON.stringify({ event: "post_readback_run_failed", message: errorText(error) }));
  }
  return summary;
}
