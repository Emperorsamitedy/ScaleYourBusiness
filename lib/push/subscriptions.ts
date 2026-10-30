// Phone-alert subscriptions — idea 53 (I-53.2).
//
// A Web Push subscription is a capability: whoever holds its endpoint and
// keys can push to that phone (MDN: "the endpoint URL therefore needs to be
// kept secret"). So it is stored the way a connection secret is (rule 10):
// the whole subscription sealed with AES-256-GCM under CONNECTOR_KEY
// (lib/connectors/secrets.ts), the endpoint findable only through a keyed
// HMAC, never logged, never returned by any API. Screens see a device
// label and two dates. The pure checks are in ./endpoints.

import { createHmac } from "node:crypto";
import { and, eq, gt, inArray, isNull, or } from "drizzle-orm";
import { db } from "../../db";
import { authSessions, pushSubscriptions, users } from "../../db/schema";
import { decryptSecret, encryptSecret } from "../connectors/secrets";
import { stableKey } from "../core/derived-key";
import { logSafeError } from "../core/log-safe";
import type { DeviceLabel, PushTarget } from "./endpoints";
import { deviceLabel, parseSubscription } from "./endpoints";

export type { DeviceLabel, PushTarget } from "./endpoints";
export {
  DEVICE_LABELS,
  FAKE_PUSH_HOST,
  deviceLabel,
  isPushEndpoint,
  parseSubscription,
} from "./endpoints";

/**
 * HMAC-SHA-256 of the endpoint under a key that never changes once rows are
 * keyed with it (stableKey, CONNECTOR_KEY's root), so the same browser
 * switching on again always finds its own row.
 */
export function endpointHash(endpoint: string): string {
  return createHmac("sha256", stableKey("syb-push-endpoint-v1")).update(endpoint).digest("hex");
}

function isZone(zone: unknown): zone is string {
  if (typeof zone !== "string" || zone.length > 64 || zone === "") return false;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** Switch a device on (or refresh it): one row per endpoint, moved to whoever switched it on last. */
export async function saveSubscription(args: {
  accountId: string;
  userId: string;
  sessionId: string | null;
  userAgent: string | null;
  target: PushTarget;
  timeZone?: unknown;
}): Promise<{ id: string; device_label: DeviceLabel }> {
  const label = deviceLabel(args.userAgent);
  // Sealed in the browser's own toJSON() shape, so opening it is the same check as receiving it.
  const sealed = encryptSecret(
    JSON.stringify({
      endpoint: args.target.endpoint,
      keys: { p256dh: args.target.p256dh, auth: args.target.auth },
    }),
  );
  const zone = isZone(args.timeZone) ? args.timeZone : null;
  const [row] = await db
    .insert(pushSubscriptions)
    .values({
      account_id: args.accountId,
      user_id: args.userId,
      session_id: args.sessionId,
      device_label: label,
      endpoint_hash: endpointHash(args.target.endpoint),
      encrypted_subscription: sealed,
      time_zone: zone,
    })
    .onConflictDoUpdate({
      target: pushSubscriptions.endpoint_hash,
      set: {
        account_id: args.accountId,
        user_id: args.userId,
        session_id: args.sessionId,
        device_label: label,
        encrypted_subscription: sealed,
        time_zone: zone,
      },
    })
    .returning({ id: pushSubscriptions.id });
  if (!row) throw new Error("could not record the subscription");
  return { id: row.id, device_label: label };
}

/** What a screen may see of a device: no endpoint, no keys. */
export interface DeviceView {
  id: string;
  label: DeviceLabel;
  created_at: string;
  last_sent_at: string | null;
  /** Switched on in the sign-in this request came with. */
  this_browser: boolean;
}

export async function listDevices(
  accountId: string,
  sessionId: string | null,
  /** Idea 52: only this person's own devices — a teammate's phones are theirs. */
  userId: string | null = null,
): Promise<DeviceView[]> {
  const rows = await db
    .select({
      id: pushSubscriptions.id,
      label: pushSubscriptions.device_label,
      created_at: pushSubscriptions.created_at,
      last_sent_at: pushSubscriptions.last_sent_at,
      session_id: pushSubscriptions.session_id,
    })
    .from(pushSubscriptions)
    .where(
      and(
        eq(pushSubscriptions.account_id, accountId),
        ...(userId ? [eq(pushSubscriptions.user_id, userId)] : []),
      ),
    )
    .orderBy(pushSubscriptions.created_at);
  return rows.map((r) => ({
    id: r.id,
    label: r.label as DeviceLabel,
    created_at: r.created_at,
    last_sent_at: r.last_sent_at,
    this_browser: sessionId !== null && r.session_id === sessionId,
  }));
}

/**
 * Remove one of the account's devices. False when it isn't this account's
 * (or is gone) — and, with `userId` (idea 52), when it isn't this person's.
 */
export async function removeDevice(
  accountId: string,
  id: string,
  userId: string | null = null,
): Promise<boolean> {
  const rows = await db
    .delete(pushSubscriptions)
    .where(
      and(
        eq(pushSubscriptions.account_id, accountId),
        eq(pushSubscriptions.id, id),
        ...(userId ? [eq(pushSubscriptions.user_id, userId)] : []),
      ),
    )
    .returning({ id: pushSubscriptions.id });
  return rows.length > 0;
}

export interface SealedDevice {
  id: string;
  label: DeviceLabel;
  target: PushTarget;
  time_zone: string | null;
  last_sent_at: string | null;
}

/**
 * Every device of the account, opened for sending. A row that no longer
 * decrypts (the key changed) or no longer parses is skipped and logged by
 * id: it can't be sent to, and the owner can remove it from the card.
 */
export async function openDevices(
  accountId: string,
  /** Idea 52: only this person's devices (the card's "Send a test"). */
  userId: string | null = null,
): Promise<SealedDevice[]> {
  // Idea 52: alerts ask for a decision, so they go only to people on the
  // team who may make one (owner or manager, not taken off); a phone whose
  // person became a viewer simply stops getting them.
  // Review 2026-10-30: and only while the sign-in that switched them on is
  // live: a session past its 90 days (or signed out) alerts nobody. A switch
  // of business hands its alerts to the new sign-in (revokeSession), so a
  // revoked session here really is a signed-out one. A row with no session
  // (none is written that way today) is judged by its person alone.
  const now = new Date().toISOString();
  const rows = (
    await db
      .select({ sub: pushSubscriptions })
      .from(pushSubscriptions)
      .innerJoin(users, eq(users.id, pushSubscriptions.user_id))
      .leftJoin(authSessions, eq(authSessions.id, pushSubscriptions.session_id))
      .where(
        and(
          eq(pushSubscriptions.account_id, accountId),
          eq(users.account_id, accountId),
          isNull(users.removed_at),
          inArray(users.role, ["owner", "manager"]),
          or(
            isNull(pushSubscriptions.session_id),
            and(isNull(authSessions.revoked_at), gt(authSessions.expires_at, now)),
          ),
          ...(userId ? [eq(pushSubscriptions.user_id, userId)] : []),
        ),
      )
      .orderBy(pushSubscriptions.created_at)
  ).map((r) => r.sub);
  const out: SealedDevice[] = [];
  for (const r of rows) {
    try {
      const target = parseSubscription(JSON.parse(decryptSecret(r.encrypted_subscription)), {
        allowFake: true,
      });
      if (typeof target === "string") throw new Error(target);
      out.push({
        id: r.id,
        label: r.device_label as DeviceLabel,
        target,
        time_zone: r.time_zone,
        last_sent_at: r.last_sent_at,
      });
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "push_subscription_unreadable",
          account_id: accountId,
          subscription_id: r.id,
          ...logSafeError(error),
        }),
      );
    }
  }
  return out;
}
