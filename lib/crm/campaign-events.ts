// Delivery signals for campaign email — P4-17 (Phase 4 Session F), rules 22 and 23.
//
// Resend reports what happened to each email it accepted through webhook
// events, Svix-signed exactly like the inbound support webhook (the same
// verifier, lib/support/inbound.ts, under this webhook's own secret).
// Shapes as Resend's docs give them (read 2026-10-19, "Webhooks → Emails →
// delivered / bounced / complained / suppressed"):
//
//   { type: "email.delivered" | "email.bounced" | "email.complained" |
//           "email.suppressed" | …,
//     created_at,
//     data: { email_id, created_at, message_id, from, to[], subject, tags,
//             broadcast_id?, template_id?,
//             bounce?: { type: "Permanent" | "Temporary" | …, subType, message },
//             suppressed?: { type, message } } }
//
// What is kept, per campaign_sends row, matched by Resend's email id (the
// id its send call answered, kept as provider_message_id):
//
//   email.delivered   delivered_at, the first time only
//   email.bounced     bounced_at + a bounce code (permanent | temporary | other)
//   email.suppressed  bounced_at + "suppressed" — Resend held it back itself
//   email.complained  complained_at, and the address is SUPPRESSED FOR GOOD
//                     (reason "complained"), exactly as an unsubscribe is:
//                     a person who marked it as spam is never emailed again
//                     by this business, whatever a later import says
//
// Everything else (sent, opened, clicked, delivery_delayed, failed,
// scheduled, received) is acknowledged and dropped. Opens and clicks in
// particular are never stored: SYB sends plain text with no pixel, so an
// "opened" event could only come from a tracking setting someone switched
// on in Resend by mistake, and it would mean nothing (P4-17's decision).
//
// No PII, ever: nothing reads `to`, `from` or `subject`; the bounce
// server's message is dropped (it quotes the address); the suppression is
// written from the send row's own keyed hash. Idempotent by construction:
// every write is conditional on the column still being empty, so a
// redelivered event changes nothing and counts once. An event for an email
// SYB doesn't know — including one whose recipient was ERASED, since
// erasure nulls the provider id (rule 22) — is acknowledged and dropped
// with a log line holding nothing but its type. An erased recipient's
// address is already suppressed by the erasure itself, so dropping a later
// complaint loses nothing.
//
// Review 2026-10-23 (#14): a send whose answer never came back (`unknown`,
// or still `sending`) has no provider id, yet the email may well have gone
// out. Every send carries its row id as a Resend tag (SEND_TAG), so an event
// no provider id matches falls back to that tag — only onto a row with no
// provider id, still `sending` or `unknown`, whose contact is not erased.
// A complaint on such a row now suppresses the address like any other.

import { createHash } from "node:crypto";
import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { db } from "../../db";
import { campaignSends, contactSuppressions, decisionLog } from "../../db/schema";
import { SEND_TAG } from "../execution/providers/email-campaign";

export type DeliveryEventKind = "delivered" | "bounced" | "suppressed" | "complained";
export type BounceCode = "permanent" | "temporary" | "suppressed" | "other";

export interface DeliveryEvent {
  kind: DeliveryEventKind;
  /** Resend's email id — the same id its send call answered. */
  email_id: string;
  /** When Resend says it happened (the event's own time). */
  at: string;
  bounce: BounceCode | null;
  /** Our campaign_sends row id, from the send's Resend tag — null when absent or not a uuid. */
  send_id: string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Pure: the send-row tag, read defensively. Resend's events give `tags` as an
 * object ({ name: value }); its send API takes an array of { name, value },
 * so both shapes are read. Anything not a uuid is ignored.
 */
export function sendIdTag(tags: unknown): string | null {
  let value: unknown;
  if (Array.isArray(tags)) {
    value = (
      tags.find((t) => (t as { name?: unknown } | null)?.name === SEND_TAG) as
        { value?: unknown } | undefined
    )?.value;
  } else if (typeof tags === "object" && tags !== null) {
    value = (tags as Record<string, unknown>)[SEND_TAG];
  }
  return typeof value === "string" && UUID_RE.test(value) ? value.toLowerCase() : null;
}

const TYPES: Readonly<Record<string, DeliveryEventKind>> = {
  "email.delivered": "delivered",
  "email.bounced": "bounced",
  "email.suppressed": "suppressed",
  "email.complained": "complained",
};

/** Resend's bounce.type, as a code. Its docs list Permanent and Temporary as examples, not a full set. */
export function bounceCode(type: unknown): BounceCode {
  if (typeof type !== "string") return "other";
  const t = type.trim().toLowerCase();
  if (t === "permanent") return "permanent";
  if (t === "temporary" || t === "transient") return "temporary";
  return "other";
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}T/;

/**
 * The webhook body, read defensively. Null = an event this file doesn't
 * keep (acknowledged and ignored), or not a Resend email event at all.
 */
export function parseDeliveryEvent(body: unknown, now: Date = new Date()): DeliveryEvent | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as { type?: unknown; created_at?: unknown; data?: unknown };
  const kind = typeof b.type === "string" ? TYPES[b.type] : undefined;
  if (!kind || typeof b.data !== "object" || b.data === null) return null;
  const d = b.data as { email_id?: unknown; bounce?: unknown; tags?: unknown };
  if (typeof d.email_id !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(d.email_id)) return null;
  const at =
    typeof b.created_at === "string" &&
    ISO_RE.test(b.created_at) &&
    !isNaN(Date.parse(b.created_at))
      ? new Date(b.created_at).toISOString()
      : now.toISOString();
  const bounce =
    kind === "bounced"
      ? bounceCode((d.bounce as { type?: unknown } | null | undefined)?.type)
      : kind === "suppressed"
        ? "suppressed"
        : null;
  return { kind, email_id: d.email_id, at, bounce, send_id: sendIdTag(d.tags) };
}

export function hashComplaint(p: { send_id: string; account_id: string; at: string }): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        kind: "complaint",
        send_id: p.send_id,
        account_id: p.account_id,
        at: p.at,
      }),
    )
    .digest("hex");
}

export type EventOutcome =
  | { kind: "recorded"; event: DeliveryEventKind; first: boolean; account_id: string }
  | { kind: "unmatched" };

/** Record one delivery event against its send row. Idempotent; no PII read or written. */
export async function applyDeliveryEvent(event: DeliveryEvent): Promise<EventOutcome> {
  const columns = {
    id: campaignSends.id,
    account_id: campaignSends.account_id,
    profile_id: campaignSends.profile_id,
    email_hash: campaignSends.email_hash,
  };
  let [row] = await db
    .select(columns)
    .from(campaignSends)
    .where(eq(campaignSends.provider_message_id, event.email_id));
  if (!row && event.send_id) {
    // The fallback (#14): our own tag, onto a row whose send answer was lost.
    [row] = await db
      .select(columns)
      .from(campaignSends)
      .where(
        and(
          eq(campaignSends.id, event.send_id),
          isNull(campaignSends.provider_message_id),
          inArray(campaignSends.status, ["sending", "unknown"]),
          isNotNull(campaignSends.contact_id),
        ),
      );
  }
  if (!row) {
    // Unknown, or erased (erasure nulls the id): nothing to attach it to.
    console.log(
      JSON.stringify({ event: "campaign_event_unmatched", account_id: null, type: event.kind }),
    );
    return { kind: "unmatched" };
  }

  let first: boolean;
  if (event.kind === "delivered") {
    const done = await db
      .update(campaignSends)
      .set({ delivered_at: event.at })
      .where(and(eq(campaignSends.id, row.id), isNull(campaignSends.delivered_at)))
      .returning({ id: campaignSends.id });
    first = done.length === 1;
  } else if (event.kind === "bounced" || event.kind === "suppressed") {
    const done = await db
      .update(campaignSends)
      .set({ bounced_at: event.at, bounce_type: event.bounce ?? "other" })
      .where(and(eq(campaignSends.id, row.id), isNull(campaignSends.bounced_at)))
      .returning({ id: campaignSends.id });
    first = done.length === 1;
  } else {
    const emailHash = row.email_hash;
    first = await db.transaction(async (tx) => {
      // The suppression first and unconditionally: from here on no send to
      // this address passes the gate (rule 23), even if the mark below lost a race.
      if (emailHash) {
        await tx
          .insert(contactSuppressions)
          .values({ account_id: row.account_id, email_hash: emailHash, reason: "complained" })
          .onConflictDoNothing();
      }
      const marked = await tx
        .update(campaignSends)
        .set({ complained_at: event.at })
        .where(and(eq(campaignSends.id, row.id), isNull(campaignSends.complained_at)))
        .returning({ id: campaignSends.id });
      if (marked.length === 0) return false;
      await tx.insert(decisionLog).values({
        profile_id: row.profile_id,
        actor: "system",
        kind: "complaint",
        ref_id: row.id,
        payload_hash: hashComplaint({ send_id: row.id, account_id: row.account_id, at: event.at }),
      });
      return true;
    });
  }
  // Ids only: never the address, its hash, or Resend's id (rule 22).
  console.log(
    JSON.stringify({
      event: "campaign_event",
      account_id: row.account_id,
      send_id: row.id,
      type: event.kind,
      first,
    }),
  );
  return { kind: "recorded", event: event.kind, first, account_id: row.account_id };
}
