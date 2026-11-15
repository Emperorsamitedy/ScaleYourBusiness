// Reading reviews from Google Business Profile — I-45a, on the daily beat.
//
// For each business that granted the Google consent: open the access at rest,
// refresh it, read the location's reviews newest-updated first, and file each
// one through the same door as a forwarded review (lib/reviews/store,
// fileReview): source "google", keyed on Google's review name so a re-read
// files nothing twice, and checked against the reviews that came by email
// so the same review isn't listed twice. A poor review raises its one alert
// like any other; a review written before the last week (the backfill on
// connecting) is filed quietly, without an alert.
//
// Capped: GOOGLE_READ_LIMITS pages per business per run, a run's businesses,
// reviews no older than the retention year. Paging stops at the first page
// that files nothing new. Never fatal to the beat: one business's failure is
// logged and recorded on its settings (a closed code the screens put in
// words), and the next business is read. Google refusing the access itself
// (a revoked grant) marks the connection failed, so the owner is told to
// connect again. Only GET reads and the token refresh, through ./client.ts's
// fence. Log lines carry the account id and counts, never a reviewer, words
// or token.

import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "../../db";
import { businessProfiles, connections, reviewSettings } from "../../db/schema";
import { logSafeError } from "../core/log-safe";
import type { GoogleBusinessEnv } from "../env";
import { googleBusinessEnv } from "../env";
import { executionSecret } from "../execution/connections";
import { REVIEW_RETENTION_DAYS, fileReview } from "../reviews/store";
import type { FetchLike } from "./client";
import { GbpRequestError, listReviewsPage, refreshAccess } from "./client";
import { GOOGLE_PROVIDER, readGoogleSecret } from "./consent";
import type { GoogleReadOutcome } from "./reasons";

export const GOOGLE_READ_LIMITS = {
  /** Pages of 50 per business per run: at most 200 reviews looked at. */
  pages_per_business: 4,
  /** Businesses per run. */
  businesses_per_run: 200,
  /** A review written longer ago than this is past its keeping before it's read. */
  max_age_days: REVIEW_RETENTION_DAYS,
  /** A review newer than this raises its alert; an older one (the backfill) is filed quietly. */
  alert_window_days: 7,
} as const;

const DAY_MS = 86_400_000;

/** The fixed sentence stored on a connection Google stopped accepting. */
export const GOOGLE_AUTH_LOST =
  "Google no longer accepts ScaleX's access. Revoke it and connect again to keep reading reviews.";

export interface BusinessRead {
  outcome: GoogleReadOutcome;
  pages: number;
  filed: number;
  alerted: number;
  known: number;
  too_old: number;
}

type ConnectionRow = typeof connections.$inferSelect;

function outcomeOf(error: unknown): GoogleReadOutcome {
  if (error instanceof GbpRequestError) {
    if (error.kind === "fence") return "fence";
    if (error.kind === "auth") return "auth";
    if (error.kind === "permission") return "permission";
    if (error.kind === "quota") return "quota";
    if (error.kind === "unavailable") return "unavailable";
    return "refused";
  }
  return "internal";
}

/** Read one business's Google reviews into the store. Throws only what the caller records. */
export async function readGoogleReviewsFor(
  row: ConnectionRow,
  env: Pick<GoogleBusinessEnv, "client_id" | "client_secret">,
  opts: { fetchImpl?: FetchLike; now?: Date } = {},
): Promise<Omit<BusinessRead, "outcome">> {
  const now = opts.now ?? new Date();
  const secret = readGoogleSecret(executionSecret(row));
  // The business must still be this account's.
  const [profile] = await db
    .select({ id: businessProfiles.id })
    .from(businessProfiles)
    .where(
      and(
        eq(businessProfiles.id, secret.profile_id),
        eq(businessProfiles.account_id, row.account_id),
      ),
    );
  if (!profile) throw new GbpRequestError("refused", "that business isn't on this account");

  const tokens = await refreshAccess(env, secret.refresh_token, opts.fetchImpl);
  const oldest = now.getTime() - GOOGLE_READ_LIMITS.max_age_days * DAY_MS;
  const alertFrom = now.getTime() - GOOGLE_READ_LIMITS.alert_window_days * DAY_MS;
  const tally = { pages: 0, filed: 0, alerted: 0, known: 0, too_old: 0 };
  let pageToken: string | null = null;
  while (tally.pages < GOOGLE_READ_LIMITS.pages_per_business) {
    const page = await listReviewsPage(tokens.access_token, secret, pageToken, opts.fetchImpl);
    tally.pages += 1;
    let filedHere = 0;
    for (const review of page.reviews) {
      const written = Date.parse(review.created_at);
      if (written < oldest) {
        tally.too_old += 1;
        continue;
      }
      const out = await fileReview(
        {
          profile_id: profile.id,
          account_id: row.account_id,
          platform: "google",
          source: "google",
          read_by: "api",
          stars: review.stars,
          reviewer: review.reviewer,
          text: review.text,
          link: secret.maps_uri,
          // Never after it reached SYB (fileReview holds that too).
          reviewed_at: review.created_at,
          received_at: now.toISOString(),
          // Unique across every business: one Google location may be read by two.
          provider_id: `gbp:${profile.id}:${review.name}`,
          fallback_id: null,
          sender_auth: null,
          dedupe_basis: `gbp|${review.name}`,
          alert: written >= alertFrom,
        },
        // A re-read of a review already on file meets the provider id's
        // unique index and files nothing: known, not a failure.
        now,
      );
      if (out.kind === "filed") {
        filedHere += 1;
        tally.filed += 1;
        if (out.alerted) tally.alerted += 1;
      } else {
        tally.known += 1;
      }
    }
    // Newest-updated first: a page with nothing new means the rest is known.
    if (filedHere === 0 || page.next === null) break;
    pageToken = page.next;
  }
  return tally;
}

async function record(row: ConnectionRow, outcome: GoogleReadOutcome, now: Date): Promise<void> {
  await db
    .update(reviewSettings)
    .set({ google_read_at: now.toISOString(), google_read_outcome: outcome })
    .where(eq(reviewSettings.account_id, row.account_id));
  if (outcome === "ok") {
    await db
      .update(connections)
      .set({ failure_count: 0, last_error: null })
      .where(eq(connections.id, row.id));
  } else if (outcome === "auth") {
    await db
      .update(connections)
      .set({
        status: "failed",
        last_error: GOOGLE_AUTH_LOST,
        failure_count: row.failure_count + 1,
      })
      .where(and(eq(connections.id, row.id), eq(connections.status, "connected")));
  } else {
    await db
      .update(connections)
      .set({ failure_count: row.failure_count + 1 })
      .where(eq(connections.id, row.id));
  }
}

export interface GoogleReadRun {
  configured: boolean;
  businesses: number;
  ok: number;
  failed: number;
  filed: number;
  alerted: number;
}

/**
 * The daily read for every business with the Google consent. Never throws
 * for one business; reports counts only.
 */
export async function runGoogleReviewReads(
  opts: {
    env?: Pick<GoogleBusinessEnv, "client_id" | "client_secret"> | null;
    fetchImpl?: FetchLike;
    now?: Date;
    /** Only these accounts: a test's own businesses (the beat reads every one). */
    accountIds?: readonly string[];
  } = {},
): Promise<GoogleReadRun> {
  const env = opts.env === undefined ? googleBusinessEnv() : opts.env;
  const run: GoogleReadRun = {
    configured: env !== null,
    businesses: 0,
    ok: 0,
    failed: 0,
    filed: 0,
    alerted: 0,
  };
  if (env === null) return run;
  const now = opts.now ?? new Date();
  const rows = await db
    .select()
    .from(connections)
    .where(
      and(
        eq(connections.provider, GOOGLE_PROVIDER),
        eq(connections.purpose, "execute"),
        eq(connections.status, "connected"),
        ...(opts.accountIds ? [inArray(connections.account_id, [...opts.accountIds])] : []),
      ),
    )
    .orderBy(asc(connections.created_at))
    .limit(GOOGLE_READ_LIMITS.businesses_per_run);
  for (const row of rows) {
    run.businesses += 1;
    let outcome: GoogleReadOutcome = "ok";
    let counts: Omit<BusinessRead, "outcome"> | null = null;
    try {
      counts = await readGoogleReviewsFor(row, env, {
        ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
        now,
      });
      run.ok += 1;
      run.filed += counts.filed;
      run.alerted += counts.alerted;
    } catch (error) {
      outcome = outcomeOf(error);
      run.failed += 1;
      if (outcome === "internal") {
        console.error(
          JSON.stringify({
            event: "google_reviews_read_failed",
            account_id: row.account_id,
            ...logSafeError(error),
          }),
        );
      }
    }
    try {
      await record(row, outcome, now);
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "google_reviews_record_failed",
          account_id: row.account_id,
          ...logSafeError(error),
        }),
      );
    }
    console.log(
      JSON.stringify({
        event: "google_reviews_read",
        account_id: row.account_id,
        connection_id: row.id,
        outcome,
        ...(counts ?? {}),
      }),
    );
  }
  return run;
}
