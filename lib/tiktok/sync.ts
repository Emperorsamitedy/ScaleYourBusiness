// The TikTok Ads daily read, run by the connector-sync cron — TikTok Ads.
//
// The measure runner never walks an execute row (P3-20b), and TikTok's
// connection is one: reading can't be separated from acting on TikTok, so
// the read rides on the execute consent, the way the post readback does
// (P3-23a, lib/content/insights.ts). This beat runs after the measure
// connections, in the same cron, and does what a measure sync does with
// what it reads: the observations land page by page with their cursor,
// then the monthly facts are derived, the anomaly check runs, the watch
// log gets its line and a connector_syncs row records the run. Reads only,
// through lib/tiktok/read.ts's fence. A failure here never fails the
// measure sync, and a failure on one connection never stops the rest.

import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../db";
import { withAdvisoryLock } from "../../db/advisory-lock";
import { connections, connectorSyncs } from "../../db/schema";
import { detectAnomalies } from "../anomaly/detect";
import { recordSyncActivity } from "../connectors/activity";
import { deriveFactsFromObservations } from "../connectors/derive";
import { decryptSecret } from "../connectors/secrets";
import { upsertObservations } from "../connectors/service";
import { logSafeError } from "../core/log-safe";
import type { TikTokContext } from "./api";
import { defaultTikTokContext } from "./api";
import { pullTikTok } from "./read";

export const TIKTOK_PROVIDER = "tiktok_ads" as const;
/** A cap on one run's pages per connection: a year of backfill is 13 windows. */
export const TIKTOK_MAX_PAGES_PER_RUN = 20;

export interface TikTokReadSummary {
  connections: number;
  ok: number;
  failed: number;
  skipped: number;
  observations: number;
}

export interface TikTokReadOptions {
  ctx?: Partial<TikTokContext>;
  accountIds?: readonly string[];
}

/** One connection's read: pages until caught up (capped), then facts, anomalies, the log line. */
export async function readTikTokConnection(
  connectionId: string,
  now: Date,
  ctx: TikTokContext,
): Promise<{ ok: boolean; skipped: boolean; observations: number; error: string | null }> {
  return withAdvisoryLock(
    `connector_sync:${connectionId}`,
    async () => {
      const [row] = await db.select().from(connections).where(eq(connections.id, connectionId));
      if (
        !row ||
        row.provider !== TIKTOK_PROVIDER ||
        row.purpose !== "execute" ||
        row.status !== "connected" ||
        row.encrypted_secret === null
      ) {
        return { ok: false, skipped: true, observations: 0, error: null };
      }
      const started = Date.now();
      const kind = row.cursor === null ? "backfill" : "incremental";
      let observations = 0;
      let pages = 0;
      let cursor = row.cursor;
      let error: string | null = null;
      try {
        const secret = decryptSecret(row.encrypted_secret);
        let done = false;
        while (!done && pages < TIKTOK_MAX_PAGES_PER_RUN) {
          const page = await pullTikTok(ctx, secret, cursor, now, row.account_id);
          await db.transaction(async (tx) => {
            observations += await upsertObservations(row.id, row.provider, page.observations, tx);
            await tx
              .update(connections)
              .set({ cursor: page.cursor })
              .where(eq(connections.id, row.id));
          });
          cursor = page.cursor;
          done = page.done;
          pages += 1;
        }
        await db
          .update(connections)
          .set({ last_sync_at: now.toISOString(), failure_count: 0, last_error: null })
          .where(eq(connections.id, row.id));
        const derived = await deriveFactsFromObservations(row.id);
        await recordSyncActivity({
          connectionId: row.id,
          accountId: row.account_id,
          provider: row.provider,
          fromCursor: row.cursor,
          toCursor: cursor,
          derived,
        });
        try {
          await detectAnomalies(row.id, now);
        } catch (e) {
          console.error(
            JSON.stringify({
              event: "anomaly_detection_failed",
              account_id: row.account_id,
              connection_id: row.id,
              ...logSafeError(e),
            }),
          );
        }
      } catch (e) {
        error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
        await db
          .update(connections)
          .set({ failure_count: row.failure_count + 1, last_error: error })
          .where(eq(connections.id, row.id));
      }
      const duration_ms = Date.now() - started;
      console.log(
        JSON.stringify({
          event: "tiktok_read",
          account_id: row.account_id,
          connection_id: row.id,
          kind,
          ok: error === null,
          pages,
          observations,
          duration_ms,
          error,
        }),
      );
      try {
        await db.insert(connectorSyncs).values({
          connection_id: row.id,
          account_id: row.account_id,
          kind,
          duration_ms,
          pages,
          observations_upserted: observations,
          ok: error === null,
          error,
        });
      } catch (e) {
        console.error(
          JSON.stringify({ event: "connector_sync_persist_failed", ...logSafeError(e) }),
        );
      }
      return { ok: error === null, skipped: false, observations, error };
    },
    () => ({ ok: false, skipped: true, observations: 0, error: null }),
  );
}

/** Every connected TikTok ad connection, one after another. */
export async function runTikTokAdsRead(
  now = new Date(),
  opts: TikTokReadOptions = {},
): Promise<TikTokReadSummary> {
  const ctx = defaultTikTokContext(opts.ctx ?? {});
  const rows = await db
    .select({ id: connections.id })
    .from(connections)
    .where(
      and(
        eq(connections.provider, TIKTOK_PROVIDER),
        eq(connections.purpose, "execute"),
        eq(connections.status, "connected"),
        opts.accountIds ? inArray(connections.account_id, [...opts.accountIds]) : undefined,
      ),
    )
    .orderBy(connections.created_at);
  const summary: TikTokReadSummary = {
    connections: rows.length,
    ok: 0,
    failed: 0,
    skipped: 0,
    observations: 0,
  };
  for (const { id } of rows) {
    try {
      const out = await readTikTokConnection(id, now, ctx);
      if (out.skipped) summary.skipped += 1;
      else if (out.ok) summary.ok += 1;
      else summary.failed += 1;
      summary.observations += out.observations;
    } catch (error) {
      summary.failed += 1;
      console.error(
        JSON.stringify({ event: "tiktok_read_failed", connection_id: id, ...logSafeError(error) }),
      );
    }
  }
  return summary;
}
