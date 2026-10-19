// Degrade to paused, and pick up again — P3-24b (Session D, layer D5).
//
// An execute connection whose sign-in Meta refuses (meta-errors' auth class:
// an expired, revoked or password-reset token) pauses ITSELF. This file is
// the one place that happens, for every caller — the publish path, the ad
// executor and the per-post readback all reach it, the first two through
// their backends, so the Meta provider never imports the database:
//
//   pause    the connection becomes `paused` with the classified sentence as
//            its reason (status + last_error, what /connections shows); every
//            QUEUED item on it flips to `failed` with the one sentence
//            ("I couldn't post — the connection expired. Reconnect and I'll
//            pick up where I left off."), marked with the connection that
//            paused it; one watch-log line says so. Idempotent: a second
//            refusal on an already-paused connection holds whatever new
//            items it finds and writes no second line.
//   hold     while paused, nothing retries: the due runner skips every
//            proposal routed to the paused provider (and holds any item
//            approved since), the publish read-back can't read, and the
//            readback only walks connected rows. Nothing is sent to Meta.
//   resume   once a connected execute row exists again for the provider —
//            through the pasted route or the Facebook-login finish, both of
//            which go through consentToExecution, and swept again on every
//            due run — every item the pause held goes back to `queued`, and
//            every run journaled `failed` with held_for "reconnect" becomes
//            runnable again. The engine re-runs it through every guard.
//
// WHAT "FAILED ONLY BECAUSE OF THE PAUSE" MEANS, precisely:
//   - an item: content_items.paused_connection_id is set. Only ever set on a
//     `failed` item (a database check), and only by this file on an item
//     that was `queued` (never claimed) or that Meta refused definitively
//     with the auth error (an error code is an answer: nothing went out).
//     An item left `publishing` — a lost answer, a post that may be live —
//     is never touched here; the P3-21d read-back settles it.
//   - a run: executions.held_for = "reconnect", written by the engine when
//     the provider's error said so (heldFor). Resuming re-runs it through
//     executeProposal; a publish run then claims the re-queued item afresh,
//     and an ad change re-reads the campaign and computes from the budget
//     captured before attempt one, so nothing compounds and nothing posts twice.

import { and, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";
import { db } from "../../db";
import {
  businessProfiles,
  connections,
  contentItems,
  executions,
  proposals,
  watchActivity,
} from "../../db/schema";
import type { MetaFailure } from "./meta-errors";
import { PAUSED_WORK_SENTENCE } from "./meta-errors";
import type { ExecutionProviderId } from "./scopes";
import { EXECUTION_SCOPE_REGISTRY } from "./scopes";

export type PausableProvider = Extract<ExecutionProviderId, "meta_publish" | "meta_ads">;

export function isPausableProvider(p: string): p is PausableProvider {
  return p === "meta_publish" || p === "meta_ads";
}

type Executor = Pick<typeof db, "insert" | "select" | "update">;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The account's profiles — the watch log and the items both hang off them. */
async function profilesOf(x: Executor, accountId: string): Promise<string[]> {
  const rows = await x
    .select({ id: businessProfiles.id })
    .from(businessProfiles)
    .where(eq(businessProfiles.account_id, accountId));
  return rows.map((r) => r.id);
}

/**
 * Every queued item on the account (and the one Meta just refused, if
 * named) → failed with the sentence, marked with the connection. Never an
 * item that is `publishing`: it may be live.
 */
async function holdItems(
  x: Executor,
  accountId: string,
  connectionId: string,
  itemId: string | null,
): Promise<number> {
  const profiles = await profilesOf(x, accountId);
  if (profiles.length === 0) return 0;
  const which = itemId
    ? sql`(${contentItems.status} = 'queued' OR (${contentItems.id} = ${itemId} AND ${contentItems.status} = 'failed'))`
    : eq(contentItems.status, "queued");
  const rows = await x
    .update(contentItems)
    .set({
      status: "failed",
      last_error: PAUSED_WORK_SENTENCE.publish,
      paused_connection_id: connectionId,
    })
    .where(and(inArray(contentItems.profile_id, profiles), which))
    .returning({ id: contentItems.id });
  return rows.length;
}

export interface PauseArgs {
  accountId: string;
  provider: PausableProvider;
  failure: MetaFailure;
  /** The item whose own publish Meta refused — already `failed`, nothing sent. */
  itemId?: string | null;
  /** What met the refusal, for the log line. */
  source: "publish" | "ad_change" | "readback";
}

export interface PauseOutcome {
  /** True when THIS call moved the connection from connected to paused. */
  paused: boolean;
  connection_id: string | null;
  /** Items held for the reconnect by this call. */
  items_held: number;
}

/** Pause the account's live execute connection for `provider`. Never throws for a missing row. */
export async function pauseExecutionConnection(args: PauseArgs): Promise<PauseOutcome> {
  const outcome = await db.transaction(async (tx) => {
    const [conn] = await tx
      .select({ id: connections.id, status: connections.status })
      .from(connections)
      .where(
        and(
          eq(connections.account_id, args.accountId),
          eq(connections.provider, args.provider),
          eq(connections.purpose, "execute"),
          ne(connections.status, "disconnected"),
        ),
      )
      .limit(1);
    if (!conn) return { paused: false, connection_id: null, items_held: 0 };

    const flipped = await tx
      .update(connections)
      .set({
        status: "paused",
        last_error: args.failure.owner_sentence,
        failure_count: sql`${connections.failure_count} + 1`,
      })
      .where(and(eq(connections.id, conn.id), eq(connections.status, "connected")))
      .returning({ id: connections.id });
    const paused = flipped.length === 1;

    const items =
      args.provider === "meta_publish"
        ? await holdItems(tx, args.accountId, conn.id, args.itemId ?? null)
        : 0;

    if (paused) {
      const label = EXECUTION_SCOPE_REGISTRY[args.provider].label;
      const waiting =
        items > 0 ? ` ${plural(items, "post is", "posts are")} waiting for the reconnect.` : "";
      const profiles = await profilesOf(tx, args.accountId);
      if (profiles.length > 0) {
        await tx.insert(watchActivity).values(
          profiles.map((profile_id) => ({
            profile_id,
            kind: "connection_paused",
            detail: `${label} paused itself. ${args.failure.owner_sentence}${waiting}`,
            meta: {
              connection_id: conn.id,
              provider: args.provider,
              code: args.failure.code,
              subcode: args.failure.subcode,
              items_held: items,
            },
          })),
        );
      }
    }
    return { paused, connection_id: conn.id, items_held: items };
  });
  console.log(
    JSON.stringify({
      event: "execution_connection_paused",
      account_id: args.accountId,
      provider: args.provider,
      connection_id: outcome.connection_id,
      source: args.source,
      transitioned: outcome.paused,
      items_held: outcome.items_held,
      code: args.failure.code,
      subcode: args.failure.subcode,
    }),
  );
  return outcome;
}

/**
 * The due runner met work for a paused connection: anything approved since
 * the pause is held the same way, so every queued item on it reads the same.
 */
export async function holdQueuedForPausedConnection(
  accountId: string,
  connectionId: string,
): Promise<number> {
  return holdItems(db, accountId, connectionId, null);
}

export interface ResumeOutcome {
  account_id: string;
  provider: PausableProvider;
  /** Items put back in the queue. */
  items: number;
  /** Runs journaled failed with held_for "reconnect", runnable again on the next due run. */
  runs: number;
}

/**
 * Pick up where the pause left off, for every (account, provider) that has a
 * CONNECTED execute row and work the pause held. Scoped to one account and
 * provider after a reconnect; unscoped from the due runner's sweep.
 */
export async function resumeAfterReconnect(
  scope: {
    accountId?: string;
    provider?: PausableProvider;
    /**
     * Write the "reconnected" watch line even when no item moved — true at
     * the reconnect itself. The due runner's sweep passes false, so held
     * runs waiting on something else (the real-write gate) don't repeat it.
     */
    announce?: boolean;
  } = {},
): Promise<ResumeOutcome[]> {
  const conditions = [
    eq(connections.purpose, "execute"),
    eq(connections.status, "connected"),
    inArray(connections.provider, ["meta_publish", "meta_ads"]),
  ];
  if (scope.accountId) conditions.push(eq(connections.account_id, scope.accountId));
  if (scope.provider) conditions.push(eq(connections.provider, scope.provider));
  const live = await db
    .select({ account_id: connections.account_id, provider: connections.provider })
    .from(connections)
    .where(and(...conditions));

  const out: ResumeOutcome[] = [];
  for (const { account_id, provider } of live) {
    if (!isPausableProvider(provider)) continue;
    const runs = await db
      .select({ id: executions.id })
      .from(executions)
      .where(
        and(
          eq(executions.account_id, account_id),
          eq(executions.provider, provider),
          eq(executions.status, "failed"),
          eq(executions.held_for, "reconnect"),
        ),
      );
    let items = 0;
    if (provider === "meta_publish") {
      const profiles = await profilesOf(db, account_id);
      if (profiles.length > 0) {
        // Back to the queue only while the owner's approval still stands.
        const approved = db
          .select({ id: proposals.id })
          .from(proposals)
          .where(and(inArray(proposals.profile_id, profiles), eq(proposals.status, "approved")));
        const rows = await db
          .update(contentItems)
          .set({ status: "queued", last_error: null, paused_connection_id: null })
          .where(
            and(
              inArray(contentItems.profile_id, profiles),
              eq(contentItems.status, "failed"),
              isNotNull(contentItems.paused_connection_id),
              inArray(contentItems.publish_proposal_id, approved),
            ),
          )
          .returning({ id: contentItems.id, profile_id: contentItems.profile_id });
        items = rows.length;
      }
    }
    if (items === 0 && runs.length === 0) continue;
    const label = EXECUTION_SCOPE_REGISTRY[provider].label;
    const what =
      provider === "meta_publish"
        ? `${plural(items, "post is", "posts are")} back in the queue and go`
        : `${plural(runs.length, "ad change goes", "ad changes go")}`;
    const profiles = await profilesOf(db, account_id);
    if (profiles.length > 0 && (items > 0 || scope.announce === true)) {
      await db.insert(watchActivity).values(
        profiles.map((profile_id) => ({
          profile_id,
          kind: "connection_resumed",
          detail: `${label} is reconnected. ${what} out on the next run, through every check again.`,
          meta: { provider, items, runs: runs.length },
        })),
      );
    }
    console.log(
      JSON.stringify({
        event: "execution_connection_resumed",
        account_id,
        provider,
        items,
        runs: runs.length,
      }),
    );
    out.push({ account_id, provider, items, runs: runs.length });
  }
  return out;
}
