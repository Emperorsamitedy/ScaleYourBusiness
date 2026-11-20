// The law review, recorded — P4-15's second gate (Phase 4 Session F), rule 23.
//
// TASKS-PHASE4 put it plainly when the regime table landed (P4-16): it is
// not legal advice, and a PERSON reviews it against current law before
// anything sends. This module makes that review a fact rather than a
// promise:
//
//   - the table's identity is the sha256 of a canonical serialisation of
//     REGIMES (keys sorted at every depth, arrays in order), so any edit to
//     any regime — a country added, a deadline moved, a source re-cited —
//     is a different table;
//   - a review is a row: who reviewed it, on what day, and the hash of the
//     table they reviewed (they submit the hash they were shown; a table
//     that changed under them is refused), plus a decision-log entry that
//     holds the hash and ids only;
//   - a send is refused unless the LATEST review's hash equals the table as
//     it is now. Editing the table voids the review by itself, with no
//     flag to remember to reset.
//
// Recorded by an operator from /ops (the OPS_KEY door). The review covers
// the whole product, not one business, so its decision-log entry is filed
// under SYSTEM_PROFILE_ID — the nil uuid — which no business profile can
// ever hold (decision_log.profile_id is deliberately not a foreign key).

import { createHash } from "node:crypto";
import { desc } from "drizzle-orm";
import { db } from "../../db";
import { decisionLog, jurisdictionReviews } from "../../db/schema";
import type { Regime, RegimeId } from "./jurisdiction";
import { REGIMES } from "./jurisdiction";

/** The decision log's home for product-wide facts: no business profile has this id. */
export const SYSTEM_PROFILE_ID = "00000000-0000-0000-0000-000000000000";

export class LawReviewError extends Error {
  readonly status: number;
  constructor(message: string, status = 422) {
    super(message);
    this.name = "LawReviewError";
    this.status = status;
  }
}

export type LawReviewRow = typeof jurisdictionReviews.$inferSelect;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonical((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** Pure: the table as one canonical string — what the reviewer's hash covers. */
export function canonicalTable(table: Readonly<Record<RegimeId, Regime>> = REGIMES): string {
  return JSON.stringify(canonical(table));
}

/** Pure: sha256 (hex) of the canonical table. */
export function jurisdictionTableHash(table: Readonly<Record<RegimeId, Regime>> = REGIMES): string {
  return createHash("sha256").update(canonicalTable(table)).digest("hex");
}

export type LawReviewState = "missing" | "stale" | "current";

export interface LawReviewVerdict {
  state: LawReviewState;
  /** In the owner's words, for the screen and the engine's refusal. */
  words: string;
  reviewed_on: string | null;
}

/** Pure: does the latest review cover the table as it is now? */
export function lawReviewVerdict(
  latest: Pick<LawReviewRow, "table_sha256" | "reviewed_on"> | null,
  currentHash: string,
): LawReviewVerdict {
  if (latest === null) {
    return {
      state: "missing",
      words:
        "Nobody has reviewed the email-law rules against current law yet, so no campaign sends.",
      reviewed_on: null,
    };
  }
  if (latest.table_sha256 !== currentHash) {
    return {
      state: "stale",
      words: `The email-law rules changed after their last review (${latest.reviewed_on}), so that review no longer covers them and no campaign sends until they are reviewed again.`,
      reviewed_on: latest.reviewed_on,
    };
  }
  return {
    state: "current",
    words: `The email-law rules were reviewed against current law on ${latest.reviewed_on}.`,
    reviewed_on: latest.reviewed_on,
  };
}

/** The most recent review on record, or null. */
export async function latestLawReview(): Promise<LawReviewRow | null> {
  const [row] = await db
    .select()
    .from(jurisdictionReviews)
    .orderBy(desc(jurisdictionReviews.recorded_at), desc(jurisdictionReviews.id))
    .limit(1);
  return row ?? null;
}

/** The verdict for the table as it is now — what the send checks. */
export async function currentLawReview(): Promise<LawReviewVerdict> {
  return lawReviewVerdict(await latestLawReview(), jurisdictionTableHash());
}

export function hashLawReview(
  row: Pick<LawReviewRow, "id" | "reviewer" | "reviewed_on" | "table_sha256" | "recorded_at">,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        kind: "law_review",
        review_id: row.id,
        // The name is hashed into the entry, never written to it.
        reviewer_sha256: createHash("sha256").update(row.reviewer).digest("hex"),
        reviewed_on: row.reviewed_on,
        table_sha256: row.table_sha256,
        recorded_at: row.recorded_at,
      }),
    )
    .digest("hex");
}

/**
 * Record that a person reviewed the table. `tableSha256` is the hash the
 * operator was SHOWN: if the table changed since, the review is refused,
 * because it would vouch for rules nobody read.
 */
export async function recordLawReview(args: {
  reviewer: string;
  reviewedOn: string;
  tableSha256: string;
  note?: string | null;
  now?: Date;
}): Promise<LawReviewRow> {
  const reviewer = args.reviewer.trim();
  if (reviewer === "") throw new LawReviewError("the reviewer's name is required");
  if (reviewer.length > 200) throw new LawReviewError("the reviewer's name is too long");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.reviewedOn) || Number.isNaN(Date.parse(args.reviewedOn))) {
    throw new LawReviewError("the review date must be a day, YYYY-MM-DD");
  }
  const today = (args.now ?? new Date()).toISOString().slice(0, 10);
  if (args.reviewedOn > today) throw new LawReviewError("a review can't be dated in the future");
  const current = jurisdictionTableHash();
  if (args.tableSha256.trim().toLowerCase() !== current) {
    throw new LawReviewError(
      "the email-law table changed since this page was opened: reload it and review the table as it is now",
      409,
    );
  }
  const note = args.note?.trim() || null;
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(jurisdictionReviews)
      .values({ reviewer, reviewed_on: args.reviewedOn, table_sha256: current, note })
      .returning();
    if (!row) throw new LawReviewError("the review could not be stored", 500);
    await tx.insert(decisionLog).values({
      profile_id: SYSTEM_PROFILE_ID,
      actor: "system",
      kind: "law_review",
      ref_id: row.id,
      payload_hash: hashLawReview(row),
    });
    console.log(
      JSON.stringify({
        event: "law_review_recorded",
        account_id: null,
        review_id: row.id,
        table_sha256: current,
        reviewed_on: row.reviewed_on,
      }),
    );
    return row;
  });
}
