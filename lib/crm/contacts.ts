// The contact spine — Phase 4 Session A (P4-01/02/04).
//
// Three rules carried in code, not intention:
//
//   Rule 19 — consent is a recorded fact. Every contact lands with a
//   status from the bank's own vocabulary plus provenance (source and
//   when), and the gate below treats the gradations as law: explicit
//   consent emails for marketing; implied, unsure and none do not.
//   The owner's own 6.4b answer sets the module's posture — a profile
//   that said "no consent" has outbound disabled wholesale until the
//   owner's data says otherwise.
//
//   Rule 22 — PII is erasable; the audit trail is not. Erasure deletes
//   the row, leaves a suppression HASH, and writes a decision-log
//   entry that names ids and hashes only. The log stays verifiable
//   forever while holding nothing personal.
//
//   Rule 23 (its foundation) — the suppression list survives
//   everything. Unsubscribes and erasures live as sha256(email);
//   re-adding a suppressed address is refused by name of the reason,
//   forever.
//
// Support contact ≠ marketing consent: nothing in this module infers
// consent from interaction. Only the owner's attestation or the
// customer's own recorded action sets a status.

import { createHash, createHmac } from "node:crypto";
import { derivedKey } from "../core/derived-key";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { db } from "../../db";
import {
  businessProfiles,
  campaignSends,
  contactSuppressions,
  contacts,
  decisionLog,
  supportConversations,
  supportEmailMessages,
  supportMessages,
  supportTickets,
} from "../../db/schema";
import { readCurrentField } from "../profile/field-store";
import { enumCode } from "../core/enum-value";

export class ContactError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "ContactError";
    this.status = status;
  }
}

export type ConsentStatus = "explicit_consent" | "implied_consent" | "no_consent" | "unsure";

export type ContactRow = typeof contacts.$inferSelect;

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * What suppression stores for an address: an HMAC under a server key,
 * prefixed "h1:". A plain sha256 of an email can be tested by anyone holding
 * the database ("was owner@x ever a contact?"); a keyed hash can't
 * (security review 2026-10-17).
 */
export function emailHash(email: string): string {
  return `h1:${createHmac("sha256", derivedKey("syb-suppression-v1")).update(normalizeEmail(email)).digest("hex")}`;
}

/**
 * The form rows written before 2026-10-17 carry: plain sha256. The emails
 * behind them are gone, so they can't be re-hashed. Every check matches
 * both forms, so no earlier unsubscribe or erasure is ever lost.
 */
export function legacyEmailHash(email: string): string {
  return createHash("sha256").update(normalizeEmail(email)).digest("hex");
}

export async function isSuppressed(accountId: string, email: string): Promise<string | null> {
  const [row] = await db
    .select({ reason: contactSuppressions.reason })
    .from(contactSuppressions)
    .where(
      and(
        eq(contactSuppressions.account_id, accountId),
        inArray(contactSuppressions.email_hash, [emailHash(email), legacyEmailHash(email)]),
      ),
    );
  return row?.reason ?? null;
}

export interface NewContact {
  email?: string | null;
  name?: string | null;
  phone?: string | null;
  consent: {
    status: ConsentStatus;
    /** How it was obtained, in words — required, not decorative. */
    source: string;
  };
}

/** Add one contact. A suppressed address is refused by its reason. */
export async function addContact(accountId: string, input: NewContact): Promise<ContactRow> {
  if (!input.email && !input.name && !input.phone) {
    throw new ContactError("a contact needs at least an email, a name or a phone", 422);
  }
  if (input.consent.source.trim() === "") {
    throw new ContactError("consent needs its provenance — how was it obtained?", 422);
  }
  const email = input.email ? normalizeEmail(input.email) : null;
  if (email) {
    const suppressed = await isSuppressed(accountId, email);
    if (suppressed) {
      throw new ContactError(
        `that address is permanently suppressed (${suppressed}) — it cannot be re-added`,
        409,
      );
    }
  }
  try {
    const [row] = await db
      .insert(contacts)
      .values({
        account_id: accountId,
        email,
        name: input.name?.trim() || null,
        phone: input.phone?.trim() || null,
        consent_status: input.consent.status,
        consent_source: input.consent.source.trim(),
      })
      .returning();
    return row as ContactRow;
  } catch (error) {
    // Drizzle wraps the pg error; the constraint name lives on cause.
    const constraint = (error as { cause?: { constraint?: string } }).cause?.constraint;
    if (constraint === "contacts_account_email_idx") {
      throw new ContactError("a contact with that email already exists", 409);
    }
    throw error;
  }
}

/* ── the consent gate (rule 19) ── */

export interface EmailPermission {
  allowed: boolean;
  reason: string;
}

/** Marketing: explicit consent, an address, and no suppression. Nothing less. */
export async function canEmailForMarketing(contact: ContactRow): Promise<EmailPermission> {
  if (!contact.email) return { allowed: false, reason: "no email address on the contact" };
  const suppressed = await isSuppressed(contact.account_id, contact.email);
  if (suppressed) return { allowed: false, reason: `suppressed (${suppressed})` };
  if (contact.consent_status !== "explicit_consent") {
    return {
      allowed: false,
      reason: `consent is "${contact.consent_status.replace(/_/g, " ")}" — marketing needs explicit consent, recorded`,
    };
  }
  return { allowed: true, reason: "explicit consent on record" };
}

/** Transactional (a reply to their own ticket): an address and no suppression. */
export async function canEmailTransactional(contact: ContactRow): Promise<EmailPermission> {
  if (!contact.email) return { allowed: false, reason: "no email address on the contact" };
  const suppressed = await isSuppressed(contact.account_id, contact.email);
  if (suppressed) return { allowed: false, reason: `suppressed (${suppressed})` };
  return { allowed: true, reason: "transactional reply to the contact's own thread" };
}

export type OutboundPosture = "enabled" | "caution" | "disabled" | "unknown";

/**
 * The module posture from the owner's own 6.4b answer
 * (customers.marketing_consent_status). "no_consent" disables outbound
 * wholesale; "unsure"/"implied" run at caution (per-contact explicit
 * consent still decides); explicit enables; unanswered is unknown —
 * treated as caution by callers, never as permission.
 */
export async function outboundPosture(profileId: string): Promise<OutboundPosture> {
  const field = await readCurrentField<unknown>(profileId, "customers.marketing_consent_status");
  const code = field && field.status === "answered" ? enumCode(field.value) : null;
  if (code === null) return "unknown";
  if (code === "no_consent") return "disabled";
  if (code === "explicit_consent") return "enabled";
  return "caution";
}

/* ── erasure (rule 22) ── */

/**
 * Erase a contact: the row goes, the suppression hash stays, and the
 * decision log records that an erasure HAPPENED — ids and hashes only,
 * nothing recoverable. Idempotent on the suppression side.
 */
export async function eraseContact(accountId: string, contactId: string): Promise<void> {
  const [contact] = await db
    .select()
    .from(contacts)
    .where(and(eq(contacts.id, contactId), eq(contacts.account_id, accountId)));
  if (!contact) throw new ContactError("no such contact", 404);

  const hash = contact.email ? emailHash(contact.email) : null;
  const [profile] = await db
    .select({ id: businessProfiles.id })
    .from(businessProfiles)
    .where(eq(businessProfiles.account_id, accountId));

  // Their support traces go too (the security review of 2026-10-17 found
  // erasure left every ticket and widget transcript behind): the tickets
  // tied to the contact, the conversations behind them, and any widget
  // conversation in which the customer typed their own email address.
  const ticketConversations = await db
    .select({ id: supportTickets.conversation_id })
    .from(supportTickets)
    .where(and(eq(supportTickets.contact_id, contactId), eq(supportTickets.account_id, accountId)));
  const emailConversations = contact.email
    ? await db
        .selectDistinct({ id: supportMessages.conversation_id })
        .from(supportMessages)
        .innerJoin(
          supportConversations,
          eq(supportConversations.id, supportMessages.conversation_id),
        )
        .where(
          and(
            eq(supportConversations.account_id, accountId),
            sql`position(${contact.email.toLowerCase()} in lower(${supportMessages.text})) > 0`,
          ),
        )
    : [];
  // P4-09: every email ticket this address wrote or was written to — a
  // suppressed sender's tickets carry no contact_id, so the address finds them.
  const emailTickets = contact.email
    ? await db
        .selectDistinct({ id: supportEmailMessages.ticket_id })
        .from(supportEmailMessages)
        .where(
          and(
            eq(supportEmailMessages.account_id, accountId),
            or(
              eq(supportEmailMessages.from_address, normalizeEmail(contact.email)),
              sql`${supportEmailMessages.to_addresses} ? ${normalizeEmail(contact.email)}`,
            ),
          ),
        )
    : [];
  const emailTicketIds = emailTickets.map((r) => r.id);
  const conversationIds = [
    ...new Set(
      [...ticketConversations, ...emailConversations]
        .map((r) => r.id)
        .filter((id): id is string => id !== null),
    ),
  ];

  await db.transaction(async (tx) => {
    if (hash) {
      await tx
        .insert(contactSuppressions)
        .values({ account_id: accountId, email_hash: hash, reason: "erasure" })
        .onConflictDoNothing();
    }
    // The tickets go whole — their email messages and replies with them
    // (ON DELETE CASCADE) — rather than surviving with contact_id nulled:
    // a ticket's summary is the customer's own words (review 2026-10-17).
    await tx
      .delete(supportTickets)
      .where(
        and(
          eq(supportTickets.account_id, accountId),
          or(
            eq(supportTickets.contact_id, contactId),
            ...(conversationIds.length > 0
              ? [inArray(supportTickets.conversation_id, conversationIds)]
              : []),
            ...(emailTicketIds.length > 0 ? [inArray(supportTickets.id, emailTicketIds)] : []),
          ),
        ),
      );
    if (conversationIds.length > 0) {
      // Messages go with their conversation (ON DELETE CASCADE).
      await tx
        .delete(supportConversations)
        .where(
          and(
            eq(supportConversations.account_id, accountId),
            inArray(supportConversations.id, conversationIds),
          ),
        );
    }
    // P4-15: their campaign sends keep their status and the address's keyed
    // hash (the suppression's own form, so counts stay true and their
    // unsubscribe link keeps working), but lose the contact and Resend's id
    // for the email — through which SYB's own key could look the address up.
    await tx
      .update(campaignSends)
      .set({ contact_id: null, provider_message_id: null })
      .where(and(eq(campaignSends.account_id, accountId), eq(campaignSends.contact_id, contactId)));
    await tx.delete(contacts).where(eq(contacts.id, contactId));
    if (profile) {
      await tx.insert(decisionLog).values({
        profile_id: profile.id,
        actor: "owner",
        kind: "erasure",
        ref_id: contactId,
        payload_hash: createHash("sha256")
          .update(
            JSON.stringify({ account_id: accountId, contact_id: contactId, email_hash: hash }),
          )
          .digest("hex"),
      });
    }
  });
  console.log(
    JSON.stringify({
      event: "contact_erased",
      account_id: accountId,
      contact_id: contactId,
      conversations_erased: conversationIds.length,
      email_tickets_erased: emailTicketIds.length,
    }),
  );
}

/**
 * Erase one widget conversation and its ticket — the GDPR path for a
 * visitor who never became a contact. The transcript goes; the decision
 * log records that an erasure happened, by id only (rule 22).
 */
export async function eraseConversation(accountId: string, conversationId: string): Promise<void> {
  const [conversation] = await db
    .select({ id: supportConversations.id, profile_id: supportConversations.profile_id })
    .from(supportConversations)
    .where(
      and(
        eq(supportConversations.id, conversationId),
        eq(supportConversations.account_id, accountId),
      ),
    );
  if (!conversation) throw new ContactError("no such conversation", 404);
  await db.transaction(async (tx) => {
    await tx
      .delete(supportTickets)
      .where(
        and(
          eq(supportTickets.account_id, accountId),
          eq(supportTickets.conversation_id, conversationId),
        ),
      );
    await tx.delete(supportConversations).where(eq(supportConversations.id, conversationId));
    await tx.insert(decisionLog).values({
      profile_id: conversation.profile_id,
      actor: "owner",
      kind: "erasure",
      ref_id: conversationId,
      payload_hash: createHash("sha256")
        .update(JSON.stringify({ account_id: accountId, conversation_id: conversationId }))
        .digest("hex"),
    });
  });
  console.log(
    JSON.stringify({
      event: "conversation_erased",
      account_id: accountId,
      conversation_id: conversationId,
    }),
  );
}

/**
 * Erase one ticket — the GDPR path for an emailer who never became a
 * contact (a suppressed address, P4-09) or whose ticket alone must go. Its
 * email messages and replies go with it (ON DELETE CASCADE), and so does a
 * widget conversation behind it. The log records the fact, by id (rule 22).
 */
export async function eraseTicket(accountId: string, ticketId: string): Promise<void> {
  const [ticket] = await db
    .select({
      id: supportTickets.id,
      profile_id: supportTickets.profile_id,
      conversation_id: supportTickets.conversation_id,
    })
    .from(supportTickets)
    .where(and(eq(supportTickets.id, ticketId), eq(supportTickets.account_id, accountId)));
  if (!ticket) throw new ContactError("no such ticket", 404);
  await db.transaction(async (tx) => {
    await tx.delete(supportTickets).where(eq(supportTickets.id, ticketId));
    if (ticket.conversation_id) {
      await tx
        .delete(supportTickets)
        .where(
          and(
            eq(supportTickets.account_id, accountId),
            eq(supportTickets.conversation_id, ticket.conversation_id),
          ),
        );
      await tx
        .delete(supportConversations)
        .where(eq(supportConversations.id, ticket.conversation_id));
    }
    await tx.insert(decisionLog).values({
      profile_id: ticket.profile_id,
      actor: "owner",
      kind: "erasure",
      ref_id: ticketId,
      payload_hash: createHash("sha256")
        .update(JSON.stringify({ account_id: accountId, ticket_id: ticketId }))
        .digest("hex"),
    });
  });
  console.log(
    JSON.stringify({ event: "ticket_erased", account_id: accountId, ticket_id: ticketId }),
  );
}

/** The account's contacts, newest first. */
export async function listContacts(accountId: string): Promise<ContactRow[]> {
  return db
    .select()
    .from(contacts)
    .where(eq(contacts.account_id, accountId))
    .orderBy(contacts.first_seen_at);
}
