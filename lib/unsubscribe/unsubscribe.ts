// Unsubscribe — P4-15 (Phase 4 Session F), rule 23: honoured immediately and permanently.
//
// The second stranger-facing surface after support, and the narrowest one
// in the product. Anyone holding a campaign email holds a link with its
// own unguessable token; the token is the WHOLE credential. No cookie is
// read or set, no session is consulted, and the link keeps working after
// the contact is erased — because what it acts on is the send row's keyed
// address hash, which erasure leaves standing on purpose (rule 22).
//
// What this module may touch is pinned by its own import-fence test
// (structure.test.ts beside it): the database, hashing, and the one write
// that matters — a contact_suppressions row with reason "unsubscribed".
// Nothing else: no contact row is read or changed, no profile, no engine,
// no proposal, nothing that could be argued with.
//
// Two verbs, deliberately different:
//   - viewUnsubscribe (GET /u/<token>): reads only, and shows the business
//     name and one button. A link scanner or a mail client's preview that
//     follows the link unsubscribes nobody.
//   - unsubscribe (POST, from that button or an RFC 8058 one-click):
//     writes the suppression at once, marks the send, and logs that it
//     happened — ids only. Idempotent: a second POST changes nothing.
//
// Token: 32 random bytes, base64url, minted per recipient at the moment of
// the send; only sha256(token) is stored (campaign_sends.unsubscribe_token_
// hash). Links never expire: the longest minimum any regime asks
// (unsubscribeLinkDays) is a floor, and "for ever" clears every floor.

import { createHash } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../../db";
import { campaignSends, contactSuppressions, decisionLog } from "../../db/schema";

/** A token as minted: 43 base64url characters. Checked before any query. */
export const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** A one-click body is a single field; anything much bigger isn't one. */
const ONE_CLICK_MAX_BYTES = 8 * 1024;

/**
 * Is this POST an RFC 8058 one-click? The body carries the field
 * `List-Unsubscribe` = `One-Click`, and RFC 8058 §3.1 lets a mail client send
 * it urlencoded OR as multipart/form-data — Gmail and Apple Mail differ.
 * Both are read; the page's own button sends `confirm=1` and is not one.
 * Review 2026-10-23 (#24): a multipart one-click used to get the page's 303.
 */
export async function isOneClickPost(contentType: string | null, body: string): Promise<boolean> {
  if (body.length > ONE_CLICK_MAX_BYTES) return false;
  const type = (contentType ?? "").toLowerCase();
  if (type.startsWith("multipart/form-data")) {
    try {
      const form = await new Response(body, {
        headers: { "content-type": contentType! },
      }).formData();
      const value = form.get("List-Unsubscribe");
      return typeof value === "string" && value.trim() === "One-Click";
    } catch {
      return false;
    }
  }
  // urlencoded, or a client that named no type at all.
  return new URLSearchParams(body.trim()).get("List-Unsubscribe") === "One-Click";
}

export const tokenHash = (token: string): string =>
  createHash("sha256").update(token).digest("hex");

export interface UnsubscribeView {
  /** The business the email came from, as it was sent. */
  business: string;
  /** True once this address is unsubscribed from the business. */
  done: boolean;
}

async function sendFor(token: string) {
  if (!TOKEN_RE.test(token)) return null;
  const [row] = await db
    .select({
      id: campaignSends.id,
      account_id: campaignSends.account_id,
      profile_id: campaignSends.profile_id,
      email_hash: campaignSends.email_hash,
      sender_name: campaignSends.sender_name,
      unsubscribed_at: campaignSends.unsubscribed_at,
    })
    .from(campaignSends)
    .where(eq(campaignSends.unsubscribe_token_hash, tokenHash(token)));
  return row ?? null;
}

/** GET: what the page shows. Null = not a link SYB minted. Writes nothing. */
export async function viewUnsubscribe(token: string): Promise<UnsubscribeView | null> {
  const row = await sendFor(token);
  if (!row || !row.email_hash) return null;
  const [suppressed] = await db
    .select({ id: contactSuppressions.id })
    .from(contactSuppressions)
    .where(
      and(
        eq(contactSuppressions.account_id, row.account_id),
        eq(contactSuppressions.email_hash, row.email_hash),
      ),
    );
  return {
    business: row.sender_name?.trim() || "this business",
    done: row.unsubscribed_at !== null || suppressed !== undefined,
  };
}

export function hashUnsubscribe(p: { send_id: string; account_id: string; at: string }): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        kind: "unsubscribe",
        send_id: p.send_id,
        account_id: p.account_id,
        at: p.at,
      }),
    )
    .digest("hex");
}

/**
 * POST: unsubscribe, now and for good. Returns the view after the write,
 * or null for a token SYB never minted.
 */
export async function unsubscribe(
  token: string,
  now: Date = new Date(),
): Promise<UnsubscribeView | null> {
  const row = await sendFor(token);
  if (!row || !row.email_hash) return null;
  const at = now.toISOString();
  const emailHash = row.email_hash;
  const first = await db.transaction(async (tx) => {
    // The suppression first: from this statement on, no send to this address passes the gate.
    await tx
      .insert(contactSuppressions)
      .values({ account_id: row.account_id, email_hash: emailHash, reason: "unsubscribed" })
      .onConflictDoNothing();
    const marked = await tx
      .update(campaignSends)
      .set({ unsubscribed_at: at })
      .where(and(eq(campaignSends.id, row.id), isNull(campaignSends.unsubscribed_at)))
      .returning({ id: campaignSends.id });
    if (marked.length === 0) return false;
    await tx.insert(decisionLog).values({
      profile_id: row.profile_id,
      actor: "system",
      kind: "unsubscribe",
      ref_id: row.id,
      payload_hash: hashUnsubscribe({ send_id: row.id, account_id: row.account_id, at }),
    });
    return true;
  });
  // Ids only: never the address, its hash, or the token (rule 22).
  console.log(
    JSON.stringify({
      event: "campaign_unsubscribe",
      account_id: row.account_id,
      send_id: row.id,
      first,
    }),
  );
  return { business: row.sender_name?.trim() || "this business", done: true };
}
