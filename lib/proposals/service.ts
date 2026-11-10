// Proposal service — Phase 3 Session A (P3-02). The decision-log kinds
// "proposal", "approval", "rejection" and "execution" have sat in the
// enum since P0-33; this module makes them real. Every state change
// happens in the same transaction as its log entry — a proposal event
// without its audit row cannot exist (rule 7, rule 12).
//
// Transitions are guarded by conditional UPDATEs, not read-then-write:
// the WHERE clause names the only legal prior state, so two racing
// deciders cannot both win, and the database — not application locking —
// is the arbiter (the field-store precedent).

import { createHash } from "node:crypto";
import { and, desc, eq, gt, inArray, lte, sql } from "drizzle-orm";
import { db } from "../../db";
import type { DbOrTx } from "../../db";
import { contentItems, decisionLog, proposals } from "../../db/schema";
import { applyCalendarEdit, calendarEditOf } from "../content/calendar";
import type { MediaStore } from "../content/media";
import { releaseUnpublishedMedia } from "../content/media";
import { approvedPublishHash } from "../execution/providers/meta";
import { approvedTikTokHash, parseTikTokSettings } from "../execution/providers/tiktok";
import { enqueuePush, schedulePushFlush } from "../push/flush";
import type { ScenarioBlock } from "../diagnosis/recommendations";

export class ProposalError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "ProposalError";
    this.status = status;
  }
}

/** What will happen, in the owner's terms — module-specific detail rides along. */
export interface ProposalAction {
  kind: string;
  summary: string;
  detail?: unknown;
}

/** Declared before approval, shown on the card (data-model §10 shape). */
export interface Reversibility {
  level: "easy" | "moderate" | "hard";
  if_you_change_your_mind: string;
}

export type ProposalRow = typeof proposals.$inferSelect;

export interface NewProposal {
  profile_id: string;
  module: string;
  originating_finding?: string | null;
  action: ProposalAction;
  scenario: ScenarioBlock;
  reversibility: Reversibility;
  /** ISO timestamp; the queue shows the window, the sweep enforces it. */
  expires_at: string;
  /** Rule 14: present ⇒ the proposal is born blocked, for the restraint view. */
  blocked_by_limit?: string | null;
}

/**
 * Canonical sha256 of a proposal event. Key order is fixed by
 * construction — do not spread inputs here (the field-store rule). The
 * log stores the hash so later tampering with the row is detectable.
 */
export function hashProposalPayload(
  kind: "proposal" | "approval" | "rejection" | "change_request" | "execution",
  payload: {
    proposal_id: string;
    profile_id: string;
    status: string;
    decided_by?: string | null;
    rejection_reason?: string | null;
    detail?: unknown;
  },
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        kind,
        proposal_id: payload.proposal_id,
        profile_id: payload.profile_id,
        status: payload.status,
        decided_by: payload.decided_by ?? null,
        rejection_reason: payload.rejection_reason ?? null,
        detail: payload.detail ?? null,
      }),
    )
    .digest("hex");
}

/**
 * Create a proposal — pending, or born blocked when a 13.5 limit is
 * named (P3-03 calls it that way). Both are "proposal" log entries: the
 * restraint view is part of the record, not an off-books shadow.
 *
 * Idea 53: this is the one place a proposal becomes pending, so it is
 * where a phone alert is queued — in the same transaction, in a savepoint
 * that can't fail it (lib/push/flush.ts), and sent after the response.
 */
export async function createProposal(
  input: NewProposal,
  /** Join the caller's transaction (a savepoint inside it): the chat's confirm, #21. */
  executor: DbOrTx = db,
): Promise<ProposalRow> {
  const blocked = typeof input.blocked_by_limit === "string" && input.blocked_by_limit !== "";
  let queued = false;
  const created = await executor.transaction(async (tx) => {
    const [row] = await tx
      .insert(proposals)
      .values({
        profile_id: input.profile_id,
        module: input.module,
        originating_finding: input.originating_finding ?? null,
        action: input.action,
        scenario: input.scenario,
        reversibility: input.reversibility,
        status: blocked ? "blocked" : "pending",
        blocked_by_limit: blocked ? input.blocked_by_limit : null,
        expires_at: input.expires_at,
      })
      .returning();
    if (!row) throw new ProposalError("could not record the proposal", 500);
    await tx.insert(decisionLog).values({
      profile_id: row.profile_id,
      actor: "system",
      kind: "proposal",
      ref_id: row.id,
      payload_hash: hashProposalPayload("proposal", {
        proposal_id: row.id,
        profile_id: row.profile_id,
        status: row.status,
        detail: { action: input.action, blocked_by_limit: row.blocked_by_limit },
      }),
    });
    queued = await enqueuePush(tx, row);
    return row;
  });
  if (queued) schedulePushFlush(created.profile_id);
  return created;
}

/**
 * Approve: pending → approved, by a named human, inside the expiry
 * window. The conditional UPDATE is the guard — no legal prior state,
 * no rows, no approval.
 */
export async function approveProposal(args: {
  proposalId: string;
  userId: string;
  /** P3-05: approve now, execute no earlier than this ISO time. */
  executeNotBefore?: string | null;
  /** Ownership scope: when set, only this profile's proposals decide. */
  profileId?: string;
}): Promise<ProposalRow> {
  return decide({
    proposalId: args.proposalId,
    userId: args.userId,
    to: "approved",
    executeNotBefore: args.executeNotBefore ?? (await carriedSchedule(args.proposalId)),
    ...(args.profileId ? { profileId: args.profileId } : {}),
  });
}

/** Reject: same guard, and the reason is required (P3-28 feeds on it). */
export async function rejectProposal(args: {
  proposalId: string;
  userId: string;
  reason: string;
  /** Ownership scope: when set, only this profile's proposals decide. */
  profileId?: string;
  /** The media store a declined publish's render is released from (Blob by default). */
  store?: MediaStore;
}): Promise<ProposalRow> {
  if (args.reason.trim() === "") {
    throw new ProposalError("declining asks why — the reason is required", 422);
  }
  const row = await decide({
    proposalId: args.proposalId,
    userId: args.userId,
    to: "rejected",
    reason: args.reason.trim(),
    ...(args.profileId ? { profileId: args.profileId } : {}),
  });
  // Review 2026-10-23 (Session D #10): a declined post's render leaves public storage.
  await releaseUnpublishedMedia(publishItemIds([row]), args.store);
  return row;
}

/** The items per-item publish proposals name (P3-21a) — for releasing their renders. */
function publishItemIds(rows: readonly { action: unknown }[]): string[] {
  return rows.flatMap((r) => {
    const a = r.action as { kind?: unknown; detail?: { item_id?: unknown } } | null;
    return a?.kind === "content_publishing" && typeof a.detail?.item_id === "string"
      ? [a.detail.item_id]
      : [];
  });
}

/**
 * Request changes — the queue's third answer: pending → changes_requested,
 * by a named human, with the owner's words (required, like a decline's
 * reason). It is not an approval, so nothing can execute from it (rule
 * 12: the engine acts on approved rows only), and not a rejection, so it
 * never counts toward P3-28's suppression. No redraft is automatic yet:
 * the words are on the record and in the decision log.
 */
export async function requestChanges(args: {
  proposalId: string;
  userId: string;
  words: string;
  /** Ownership scope: when set, only this profile's proposals decide. */
  profileId?: string;
}): Promise<ProposalRow> {
  if (args.words.trim() === "") {
    throw new ProposalError(
      "asking for changes needs the changes — say what should be different",
      422,
    );
  }
  return decide({
    proposalId: args.proposalId,
    userId: args.userId,
    to: "changes_requested",
    reason: args.words.trim(),
    ...(args.profileId ? { profileId: args.profileId } : {}),
  });
}

/**
 * P3-21a: a proposal may carry its own posting time (action.detail.publish_at,
 * a publish proposal's date at its posting hour). Approving without choosing
 * a time keeps that one; an owner-picked time always wins.
 *
 * P3-22b: a proposal may instead say `execute_on_approval: true` (the ad
 * changes): approving without a time schedules it for now, so the next due
 * run picks it up. Without either, an unscheduled approval never runs by
 * itself — the runner only takes scheduled ones.
 */
async function carriedSchedule(proposalId: string): Promise<string | null> {
  const [row] = await db
    .select({ action: proposals.action })
    .from(proposals)
    .where(eq(proposals.id, proposalId));
  const detail = (
    row?.action as { detail?: { publish_at?: unknown; execute_on_approval?: unknown } } | null
  )?.detail;
  const at = detail?.publish_at;
  if (typeof at === "string" && !Number.isNaN(Date.parse(at))) return new Date(at).toISOString();
  return detail?.execute_on_approval === true ? new Date().toISOString() : null;
}

const LOG_KIND = {
  approved: "approval",
  rejected: "rejection",
  changes_requested: "change_request",
} as const;

async function decide(args: {
  proposalId: string;
  userId: string;
  to: "approved" | "rejected" | "changes_requested";
  reason?: string;
  executeNotBefore?: string | null;
  profileId?: string;
}): Promise<ProposalRow> {
  const now = new Date().toISOString();
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(proposals)
      .set({
        status: args.to,
        decided_by: args.userId,
        decided_at: now,
        rejection_reason: args.to === "rejected" ? (args.reason as string) : null,
        change_request: args.to === "changes_requested" ? (args.reason as string) : null,
        execute_not_before: args.to === "approved" ? (args.executeNotBefore ?? null) : null,
      })
      .where(
        and(
          eq(proposals.id, args.proposalId),
          eq(proposals.status, "pending"),
          gt(proposals.expires_at, now),
          // Ownership clause (2026-09-26 review): a decision reaches only
          // the caller's own profile — a leaked foreign id decides nothing.
          ...(args.profileId ? [eq(proposals.profile_id, args.profileId)] : []),
        ),
      )
      .returning();
    if (!row) {
      // Explain the refusal honestly: decided, expired, or missing?
      // A foreign profile's proposal is "missing" on purpose — 404, not
      // 403: existence is not confirmed across the boundary.
      const [cur] = await tx
        .select({ status: proposals.status, expires_at: proposals.expires_at })
        .from(proposals)
        .where(
          and(
            eq(proposals.id, args.proposalId),
            ...(args.profileId ? [eq(proposals.profile_id, args.profileId)] : []),
          ),
        );
      if (!cur) throw new ProposalError("no such proposal", 404);
      // As instants (review 2026-10-30): the column reads back in Postgres
      // format, `now` is ISO, and the two don't sort alike as strings.
      if (cur.status === "pending" && Date.parse(cur.expires_at) <= Date.parse(now)) {
        throw new ProposalError(
          "this proposal has expired — it needs re-proposing, not deciding",
          409,
        );
      }
      throw new ProposalError(`this proposal is already ${cur.status}`, 409);
    }
    // P3-21e: approving a per-item publish proposal puts its item in the
    // publishing queue (drafted → queued), in the same transaction.
    // Review 2026-10-23 (Session D #10): and records what was approved, by
    // hash — the caption as it goes out and the media URL — so the publish
    // path can refuse anything else.
    const act = row.action as {
      kind?: unknown;
      detail?: { item_id?: unknown; platform?: unknown };
    } | null;
    let contentSha256: string | null = null;
    if (
      args.to === "approved" &&
      act?.kind === "content_publishing" &&
      typeof act.detail?.item_id === "string"
    ) {
      const mine = and(
        eq(contentItems.id, act.detail.item_id),
        eq(contentItems.publish_proposal_id, row.id),
        eq(contentItems.status, "drafted"),
      );
      const [item] = await tx
        .select({
          body: contentItems.body,
          disclosure: contentItems.disclosure,
          media_path: contentItems.media_path,
          tiktok_settings: contentItems.tiktok_settings,
        })
        .from(contentItems)
        .where(mine)
        .for("update");
      if (item) {
        // 2026-11-08: a TikTok post's approval covers the settings the owner
        // chose for it (privacy, interactions), and can't be given without them.
        const tiktok = act.detail?.platform === "tiktok";
        if (tiktok && parseTikTokSettings(item.tiktok_settings) === null) {
          throw new ProposalError(
            "choose who can see it on TikTok first, on Content — then approve it",
            409,
          );
        }
        contentSha256 = tiktok ? approvedTikTokHash(item) : approvedPublishHash(item);
        await tx
          .update(contentItems)
          .set({ status: "queued", publish_approved_sha256: contentSha256 })
          .where(mine);
      }
    }
    // Review 2026-10-23, #8: a calendar edit drafted in chat (move an item
    // to another day, or rename it) is MADE by its approval, in this same
    // transaction, through the content module's own write — which re-checks
    // the item is still as the card quoted it. If it isn't, nothing is
    // approved and nothing changes.
    const calendar = args.to === "approved" ? calendarEditOf(row.action) : null;
    if (calendar) {
      const edited = await applyCalendarEdit(tx, { profileId: row.profile_id, ...calendar });
      if (!edited) {
        throw new ProposalError(
          "that calendar item has changed since this was proposed, or it's already headed for publishing, so nothing was changed — decline this one and ask me again",
          409,
        );
      }
    }
    const kind = LOG_KIND[args.to];
    await tx.insert(decisionLog).values({
      profile_id: row.profile_id,
      actor: "owner",
      kind,
      user_id: args.userId,
      ref_id: row.id,
      payload_hash: hashProposalPayload(kind, {
        proposal_id: row.id,
        profile_id: row.profile_id,
        status: row.status,
        decided_by: row.decided_by,
        rejection_reason: row.rejection_reason,
        ...(row.change_request ? { detail: { change_request: row.change_request } } : {}),
        ...(contentSha256 ? { detail: { content_sha256: contentSha256 } } : {}),
      }),
    });
    if (calendar) {
      const result = {
        content_item_id: calendar.itemId,
        op: calendar.edit.op,
        from: calendar.edit.from,
        to: calendar.edit.to,
      };
      const [executed] = await tx
        .update(proposals)
        .set({ status: "executed", execution_result: sql`${JSON.stringify(result)}::jsonb` })
        .where(and(eq(proposals.id, row.id), eq(proposals.status, "approved")))
        .returning();
      if (!executed) throw new ProposalError("could not record the calendar change", 500);
      await tx.insert(decisionLog).values({
        profile_id: executed.profile_id,
        actor: "system",
        kind: "execution",
        ref_id: executed.id,
        payload_hash: hashProposalPayload("execution", {
          proposal_id: executed.id,
          profile_id: executed.profile_id,
          status: executed.status,
          decided_by: executed.decided_by,
          detail: result,
        }),
      });
      return executed;
    }
    return row;
  });
}

/**
 * Record an execution result: approved → executed. Only the Session B
 * engine calls this; it exists now so "execution" log entries are real
 * from the spine up. The engine's own guards (watching mode, emergency
 * stop, idempotency) sit in front of it — this is the last step, not
 * the doorway.
 */
/** A transaction handle, so a caller can make the flip part of its own transaction. */
export type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function recordExecution(
  args: {
    proposalId: string;
    result: unknown;
  },
  outer?: DbTx,
): Promise<ProposalRow> {
  const inTx = async (tx: DbTx): Promise<ProposalRow> => {
    const [row] = await tx
      .update(proposals)
      .set({ status: "executed", execution_result: sql`${JSON.stringify(args.result)}::jsonb` })
      .where(and(eq(proposals.id, args.proposalId), eq(proposals.status, "approved")))
      .returning();
    if (!row) {
      const [cur] = await tx
        .select({ status: proposals.status })
        .from(proposals)
        .where(eq(proposals.id, args.proposalId));
      if (!cur) throw new ProposalError("no such proposal", 404);
      throw new ProposalError(
        `only an approved proposal can execute — this one is ${cur.status}`,
        409,
      );
    }
    await tx.insert(decisionLog).values({
      profile_id: row.profile_id,
      actor: "system",
      kind: "execution",
      ref_id: row.id,
      payload_hash: hashProposalPayload("execution", {
        proposal_id: row.id,
        profile_id: row.profile_id,
        status: row.status,
        decided_by: row.decided_by,
        detail: args.result,
      }),
    });
    return row;
  };
  return outer ? inTx(outer) : db.transaction(inTx);
}

/* ── P3-06: expiry, and the queue read ── */

/**
 * Sweep due proposals: pending past expires_at become expired. No
 * decision-log entry — expiry is the absence of a decision, not one.
 * Runs deterministically at queue-read time; no cron needed for
 * correctness, only for tidiness.
 */
export async function expireDueProposals(
  profileId: string,
  store?: MediaStore,
  at: Date = new Date(),
): Promise<number> {
  const now = at.toISOString();
  const rows = await db
    .update(proposals)
    .set({ status: "expired" })
    .where(
      and(
        eq(proposals.profile_id, profileId),
        eq(proposals.status, "pending"),
        lte(proposals.expires_at, now),
      ),
    )
    .returning({ id: proposals.id, action: proposals.action });
  // Review 2026-10-23 (Session D #10): an expired post's render leaves public storage.
  await releaseUnpublishedMedia(publishItemIds(rows), store);
  return rows.length;
}

/**
 * Architecture-v2 I6: the emergency stop cancels every approval still
 * waiting — pending → expired, in the stop's own transaction. Like expiry,
 * no decision-log entry here: the stop itself is logged. Returns the content
 * items whose unpublished renders should leave public storage once the
 * transaction has committed.
 */
export async function cancelPendingProposals(
  executor: DbOrTx,
  profileIds: readonly string[],
): Promise<string[]> {
  if (profileIds.length === 0) return [];
  const rows = await executor
    .update(proposals)
    .set({ status: "expired" })
    .where(and(inArray(proposals.profile_id, [...profileIds]), eq(proposals.status, "pending")))
    .returning({ id: proposals.id, action: proposals.action });
  return publishItemIds(rows);
}

/**
 * The same sweep across every profile — the due runner's first step
 * (P3-20e), so expiry is tidy on a clock as well as at queue-read time.
 */
export async function expireAllDueProposals(now = new Date(), store?: MediaStore): Promise<number> {
  const rows = await db
    .update(proposals)
    .set({ status: "expired" })
    .where(and(eq(proposals.status, "pending"), lte(proposals.expires_at, now.toISOString())))
    .returning({ id: proposals.id, action: proposals.action });
  await releaseUnpublishedMedia(publishItemIds(rows), store);
  return rows.length;
}

export interface ProposalQueue {
  /** Awaiting the owner — the only group that badges (ux-spec §3). */
  pending: ProposalRow[];
  /** Born blocked by a 13.5 limit — the restraint view (rule 14). */
  blocked: ProposalRow[];
  /** Approved, rejected, changes requested, executed — history, newest first. */
  decided: ProposalRow[];
  /** Ran out of time, undecided. Never mixed with rejected (P3-06). */
  expired: ProposalRow[];
}

/**
 * The queue, swept then grouped. One read serves screen and badge both.
 * `at` is the clock the sweep expires against — the real one, except in a
 * test pinned to a date, whose proposals would otherwise expire on their
 * own once the calendar passes it.
 */
export async function proposalQueue(
  profileId: string,
  at: Date = new Date(),
): Promise<ProposalQueue> {
  await expireDueProposals(profileId, undefined, at);
  const rows = await db
    .select()
    .from(proposals)
    .where(eq(proposals.profile_id, profileId))
    .orderBy(desc(proposals.created_at));
  const queue: ProposalQueue = { pending: [], blocked: [], decided: [], expired: [] };
  for (const row of rows) {
    if (row.status === "pending") queue.pending.push(row);
    else if (row.status === "blocked") queue.blocked.push(row);
    else if (row.status === "expired") queue.expired.push(row);
    else queue.decided.push(row);
  }
  return queue;
}
