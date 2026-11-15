// Consent to campaign email — P4-15 (Phase 4 Session F), rules 13 and 23.
//
// Write access is its own consent, never an upgrade (rule 13) — and this
// one is unusual: there is no owner credential. Campaigns send from SYB's
// OWN Resend account, so what the owner grants is permission, not a key.
// The decision, recorded: the "execute connection" is a `connections` row
// with purpose = execute, provider = email_campaign, NO secret
// (encrypted_secret stays null for its whole life), exactly the registry's
// scopes, and the sender identity — the name campaigns go out under and
// the address replies come back to (migration 0048's sender_name /
// reply_to, which a check confines to this row). It comes in through this
// door only; connectForExecution, which proves and encrypts a credential,
// has nothing to prove here.
//
// The rest follows P3-20h exactly: the consent lines rendered verbatim from
// the registry (with {sender} filled), a typed phrase, a decision-log
// `consent` row whose hash covers the lines as shown, the scopes, the
// phrase and the sender — and if that row can't be written, the connection
// is disconnected again, so no write permission stands without its consent
// on record. Disconnect is one click (disconnectExecution).

import { createHash } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { db } from "../../db";
import { businessProfiles, connections, decisionLog } from "../../db/schema";
import type { PublicExecutionConnection } from "./connections";
import {
  ExecutionConnectionError,
  activeExecutionConnection,
  disconnectExecution,
  expectedExecutionScopes,
  toPublicExecutionConnection,
  verifyExecutionScopes,
} from "./connections";
import { emailConsentLines, senderIdentity } from "./email-sender";

export const EMAIL_CAMPAIGN_PHRASE = "allow campaign email";

/** Said beside the consent: what connecting does and doesn't do. */
export const EMAIL_NOTHING_SENT =
  "Granting records your consent. Nothing is sent until you approve a campaign and then the email itself, and every recipient is checked again at the moment it goes.";

/** Said beside disconnect. */
export const EMAIL_DISCONNECT_NOTE =
  "Disconnecting stops every campaign send at once. It can't recall an email already sent.";

export { emailConsentLines, senderIdentity } from "./email-sender";

/**
 * Review 2026-10-23 (#5a): said on /connections while CAMPAIGN_EMAIL_FROM is
 * unset — campaigns and SYB's sign-in emails then go from one address.
 * Null once campaigns have a sender of their own.
 */
export function sharedSenderNote(campaignFrom: string | null): string | null {
  return campaignFrom
    ? null
    : "For now, campaigns and ScaleX's own sign-in emails go out from the same sending address. If a campaign drew many spam complaints, sign-in emails could be slowed too.";
}

const EMAIL_RE = /^[^@\s<>"]+@[^@\s<>"]+\.[^@\s<>"]+$/;

/** Pure: the owner's sender identity, checked. Throws by name. */
export function checkSender(
  senderName: string,
  replyTo: string,
): { name: string; reply_to: string } {
  const name = senderName.trim();
  const reply_to = replyTo.trim().toLowerCase();
  if (name === "" || name.length > 80 || /["<>\r\n\\]/.test(name)) {
    throw new ExecutionConnectionError(
      "the sender name must be your business name: one line, at most 80 characters, no quotes or angle brackets",
      422,
    );
  }
  if (!EMAIL_RE.test(reply_to) || reply_to.length > 200) {
    throw new ExecutionConnectionError(
      "replies need an email address you read, such as hello@yourbusiness.com",
      422,
    );
  }
  return { name, reply_to };
}

export function hashEmailConsent(p: {
  account_id: string;
  connection_id: string;
  granted_scopes: readonly string[];
  consent_lines: readonly string[];
  typed_confirmation: string;
  sender_name: string;
  reply_to: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        kind: "consent",
        account_id: p.account_id,
        connection_id: p.connection_id,
        provider: "email_campaign",
        granted_scopes: [...p.granted_scopes].sort(),
        consent_lines: [...p.consent_lines],
        typed_confirmation: p.typed_confirmation,
        sender_name: p.sender_name,
        reply_to: p.reply_to,
      }),
    )
    .digest("hex");
}

/**
 * Grant campaign email: refused, with nothing stored, unless the phrase
 * matches and the sender identity is sound; then stored and logged.
 */
export async function consentToCampaignEmail(args: {
  accountId: string;
  senderName: string;
  replyTo: string;
  confirmation: string;
  /** I-52d: the signed-in person who consented, recorded on the log entry. */
  userId?: string | null;
}): Promise<{ connection: PublicExecutionConnection; consent_hash: string }> {
  if (args.confirmation.trim().toLowerCase() !== EMAIL_CAMPAIGN_PHRASE) {
    throw new ExecutionConnectionError(
      `type "${EMAIL_CAMPAIGN_PHRASE}" to confirm — nothing was connected`,
      422,
    );
  }
  const sender = checkSender(args.senderName, args.replyTo);
  const [profile] = await db
    .select({ id: businessProfiles.id })
    .from(businessProfiles)
    .where(eq(businessProfiles.account_id, args.accountId))
    .orderBy(asc(businessProfiles.created_at))
    .limit(1);
  if (!profile) throw new ExecutionConnectionError("no business profile on this account yet", 409);
  if (await activeExecutionConnection(args.accountId, "email_campaign")) {
    throw new ExecutionConnectionError(
      "Campaign email is already granted — disconnect it first to change the sender",
      409,
    );
  }
  const scopes = expectedExecutionScopes("email_campaign");
  verifyExecutionScopes("email_campaign", scopes);

  let row: typeof connections.$inferSelect | undefined;
  try {
    [row] = await db
      .insert(connections)
      .values({
        account_id: args.accountId,
        provider: "email_campaign",
        purpose: "execute",
        status: "connected",
        encrypted_secret: null,
        granted_scopes: [...scopes],
        sender_name: sender.name,
        reply_to: sender.reply_to,
      })
      .returning();
  } catch (error) {
    const constraint = (error as { cause?: { constraint?: string } }).cause?.constraint;
    if (constraint === "connections_active_idx") {
      throw new ExecutionConnectionError("Campaign email is already granted", 409);
    }
    throw error;
  }
  if (!row) throw new ExecutionConnectionError("the consent could not be stored", 500);

  const consent_hash = hashEmailConsent({
    account_id: args.accountId,
    connection_id: row.id,
    granted_scopes: scopes,
    consent_lines: emailConsentLines(senderIdentity(sender.name, sender.reply_to)),
    typed_confirmation: EMAIL_CAMPAIGN_PHRASE,
    sender_name: sender.name,
    reply_to: sender.reply_to,
  });
  try {
    await db.insert(decisionLog).values({
      profile_id: profile.id,
      actor: "owner",
      kind: "consent",
      ref_id: row.id,
      payload_hash: consent_hash,
      user_id: args.userId ?? null,
    });
  } catch (error) {
    // No consent on record means no permission standing.
    await disconnectExecution(args.accountId, row.id);
    throw error;
  }
  console.log(
    JSON.stringify({
      event: "execution_consent",
      account_id: args.accountId,
      provider: "email_campaign",
      connection_id: row.id,
    }),
  );
  return { connection: toPublicExecutionConnection(row), consent_hash };
}
