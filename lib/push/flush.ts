// Queueing and sending phone alerts — idea 53 (I-53.4).
//
//   enqueuePush       called by createProposal, the one place a proposal is
//                     born pending, inside its transaction and a savepoint
//                     of its own. It writes an outbox row only when the
//                     account has a device switched on, and it never throws:
//                     a push problem can't fail a proposal.
//   schedulePushFlush after the response of the request that made the
//                     proposal (next/server `after`), so a run that makes
//                     three proposals sends one alert for all three.
//   flushPushes       one account: read its outbox, let pushPlan decide,
//                     send once to each device, delete a dead subscription.
//   flushHeldPushes   every account with something held, for the daily beat
//                     (app/api/cron/push-held) that sends what quiet hours
//                     and the daily cap kept back.
//
// No retry anywhere: an alert that fails is logged with the account id and
// is not sent again. The proposal is still in the queue, and still in the
// weekly email.

import { eq, inArray, sql } from "drizzle-orm";
import { after } from "next/server";
import { db } from "../../db";
import type { DbOrTx } from "../../db";
import {
  businessProfiles,
  executionHalts,
  proposals,
  pushOutbox,
  pushSubscriptions,
} from "../../db/schema";
import { logSafeError } from "../core/log-safe";
import { COUNTRY_KEY, TIMEZONE_KEY, isValidZone, zoneForCountry } from "../hours/timezone";
import { readCurrentField } from "../profile/field-store";
import type { PushPlan } from "./plan";
import { pushPlan } from "./plan";
import { deliverAll } from "./deliver";
import type { PushService } from "./send";
import { pushConfig } from "./send";
import type { SealedDevice } from "./subscriptions";
import { openDevices } from "./subscriptions";

export type { DeviceOutcome } from "./deliver";
export { TEST_PAYLOAD, sendTestPush } from "./deliver";

/**
 * Queue a pending proposal's alert. Inside the caller's transaction, in a
 * savepoint, so a failure here rolls back only this insert. True when a row
 * was written (the account has a device).
 */
export async function enqueuePush(
  tx: DbOrTx,
  proposal: { id: string; profile_id: string; status: string },
): Promise<boolean> {
  if (proposal.status !== "pending") return false;
  try {
    return await tx.transaction(async (sp) => {
      const res = await sp.execute(sql`
        INSERT INTO ${pushOutbox} (proposal_id, profile_id)
        SELECT ${proposal.id}::uuid, ${proposal.profile_id}::uuid
        WHERE EXISTS (
          SELECT 1 FROM ${pushSubscriptions} ps
          JOIN ${businessProfiles} bp ON bp.account_id = ps.account_id
          WHERE bp.id = ${proposal.profile_id}::uuid
        )
        ON CONFLICT DO NOTHING
        RETURNING proposal_id`);
      return res.rows.length > 0;
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "push_enqueue_failed",
        profile_id: proposal.profile_id,
        proposal_id: proposal.id,
        ...logSafeError(error),
      }),
    );
    return false;
  }
}

/** Flush this account after the response. Outside a request (a script, a test) the daily beat sends it. */
export function schedulePushFlush(profileId: string): void {
  try {
    after(async () => {
      try {
        await flushPushes(profileId);
      } catch (error) {
        console.error(
          JSON.stringify({
            event: "push_flush_failed",
            profile_id: profileId,
            ...logSafeError(error),
          }),
        );
      }
    });
  } catch {
    /* not inside a request */
  }
}

/** The business's own zone: the owner's, or the one a single-zone country gives. Reads only. */
async function businessZone(profileId: string): Promise<string | null> {
  const tz = await readCurrentField<string>(profileId, TIMEZONE_KEY);
  if (tz && typeof tz.value === "string" && isValidZone(tz.value)) return tz.value;
  const country = await readCurrentField<string>(profileId, COUNTRY_KEY);
  if (country?.status === "answered" && typeof country.value === "string") {
    const found = zoneForCountry(country.value);
    if (found.zone) return found.zone;
  }
  return null;
}

/**
 * Quiet hours are kept in the business's timezone. When it isn't known,
 * the zone the owner's own phone reported when it was switched on, the
 * newest first; failing that, UTC.
 */
export function quietZone(business: string | null, devices: readonly SealedDevice[]): string {
  if (business) return business;
  const reported = [...devices].reverse().find((d) => d.time_zone && isValidZone(d.time_zone));
  return reported?.time_zone ?? "UTC";
}

export interface FlushResult {
  plan: PushPlan["act"] | "nothing" | "not_configured";
  why?: string;
  /** For a hold: when the next try can send. */
  until?: string;
  sent: number;
  gone: number;
  failed: number;
}

export async function flushPushes(
  profileId: string,
  opts: { service?: PushService; now?: Date } = {},
): Promise<FlushResult> {
  let service = opts.service;
  if (!service) {
    const cfg = pushConfig();
    if (!cfg.ok) return { plan: "not_configured", sent: 0, gone: 0, failed: 0 };
    service = cfg.service;
  }
  const now = opts.now ?? new Date();
  const [profile] = await db
    .select({ account_id: businessProfiles.account_id })
    .from(businessProfiles)
    .where(eq(businessProfiles.id, profileId));
  if (!profile) return { plan: "nothing", sent: 0, gone: 0, failed: 0 };
  const accountId = profile.account_id;

  const decided = await db.transaction(async (tx) => {
    // One flush per account at a time: two after() callbacks of one run
    // can't both send. The second finds the outbox already emptied.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`push:${accountId}`}))`);
    const queued = await tx
      .select({
        proposal_id: pushOutbox.proposal_id,
        status: proposals.status,
        kind: sql<string | null>`${proposals.action}->>'kind'`,
        expires_at: proposals.expires_at,
      })
      .from(pushOutbox)
      .innerJoin(proposals, eq(proposals.id, pushOutbox.proposal_id))
      .where(eq(pushOutbox.profile_id, profileId))
      .orderBy(pushOutbox.created_at);
    if (queued.length === 0) return null;
    const devices = await openDevices(accountId);
    const [halt] = await tx
      .select({ account_id: executionHalts.account_id })
      .from(executionHalts)
      .where(eq(executionHalts.account_id, accountId));
    const lastSentAt =
      devices
        .map((d) => d.last_sent_at)
        .filter((x): x is string => x !== null)
        .sort()
        .at(-1) ?? null;
    const plan = pushPlan({
      now,
      zone: quietZone(await businessZone(profileId), devices),
      halted: halt !== undefined,
      devices: devices.length,
      lastSentAt,
      queued,
    });
    const settled = plan.act === "send" ? [...plan.send, ...plan.drop] : plan.drop;
    if (settled.length > 0) {
      await tx.delete(pushOutbox).where(inArray(pushOutbox.proposal_id, settled));
    }
    if (plan.act === "send") {
      // Counted when decided, not when delivered: a failed alert still uses the day's one.
      await tx
        .update(pushSubscriptions)
        .set({ last_sent_at: now.toISOString() })
        .where(eq(pushSubscriptions.account_id, accountId));
    }
    console.log(
      JSON.stringify({
        event: "push_plan",
        account_id: accountId,
        act: plan.act,
        ...(plan.act === "send" ? { count: plan.send.length } : { why: plan.why }),
        ...(plan.act === "hold" ? { until: plan.until, count: plan.keep.length } : {}),
        dropped: plan.drop.length,
      }),
    );
    return { plan, devices };
  });

  if (!decided) return { plan: "nothing", sent: 0, gone: 0, failed: 0 };
  const { plan, devices } = decided;
  if (plan.act === "hold") {
    return { plan: "hold", why: plan.why, until: plan.until, sent: 0, gone: 0, failed: 0 };
  }
  if (plan.act !== "send") return { plan: plan.act, why: plan.why, sent: 0, gone: 0, failed: 0 };
  const tally = await deliverAll(accountId, devices, plan.payload, service, "proposals");
  return { plan: "send", ...tally };
}

/** Every account holding something: the daily beat. One account's failure doesn't stop the rest. */
export async function flushHeldPushes(
  opts: { service?: PushService; now?: Date } = {},
): Promise<{ accounts: number; sent: number; held: number; failed: number }> {
  const rows = await db.selectDistinct({ profile_id: pushOutbox.profile_id }).from(pushOutbox);
  let sent = 0;
  let held = 0;
  let failed = 0;
  for (const r of rows) {
    try {
      const out = await flushPushes(r.profile_id, opts);
      sent += out.sent;
      failed += out.failed;
      if (out.plan === "hold") held += 1;
    } catch (error) {
      failed += 1;
      console.error(
        JSON.stringify({
          event: "push_flush_failed",
          profile_id: r.profile_id,
          ...logSafeError(error),
        }),
      );
    }
  }
  return { accounts: rows.length, sent, held, failed };
}

/** For tests and the cron: what the outbox holds for an account. */
export async function queuedFor(profileId: string): Promise<string[]> {
  const rows = await db
    .select({ id: pushOutbox.proposal_id })
    .from(pushOutbox)
    .where(eq(pushOutbox.profile_id, profileId));
  return rows.map((r) => r.id);
}
