// Inbound support email, the ticket half — Phase 4 Session C (P4-09).
//
// One normalised email (lib/support/inbound.ts) in; one ticket thread out.
//
//   Routing. Each business has an inbound address s-<token>@<domain>; the
//   owner forwards their support mailbox to it. The token is unguessable
//   and rotatable. Mail whose addresses carry no known token is
//   acknowledged and dropped, with a log line that holds no PII.
//
//   Threading. A reply joins its ticket — by the thread token in the
//   reply-to address we send from (s-<token>+<thread>@…), or by its
//   In-Reply-To / References naming a Message-ID already on one of this
//   business's tickets. Anything else opens a new ticket (reason
//   "emailed"). A customer writing back on an answered ticket reopens it:
//   someone is waiting again.
//
//   Idempotency. The provider's id is UNIQUE on the message row, so a
//   redelivered webhook files nothing twice — checked first, and held by
//   the constraint inside the transaction for a delivery racing itself.
//
//   Contacts (rule 19). The sender becomes a consent-"unsure" contact,
//   an existing contact's consent is never touched, and a suppressed
//   address is not recreated — the ticket still exists, marked so the
//   owner's screen says replies to it are refused.
//
// Stranger-facing (rule 21): lib/support and the database only. Nothing
// here drafts, sends or executes; the only things an email can create are
// a ticket, its message row and a consent-unsure contact.

import { randomBytes } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "../../db";
import { supportEmailMessages, supportSettings, supportTickets } from "../../db/schema";
import type { InboundEmail } from "./inbound";
import { contactForSupport, emailedSource } from "./support-contact";

export type EmailMessageRow = typeof supportEmailMessages.$inferSelect;

export const ROUTING_TOKEN_RE = /^[0-9a-f]{32}$/;
// A thread token is 24 hex chars; 32-char ones minted before 2026-10-19 still parse.
const ADDRESS_TOKEN_RE = /^s-([0-9a-f]{32})(?:\+([0-9a-f]{24}|[0-9a-f]{32}))?@([a-z0-9.-]+)$/;

/** RFC 5321 §4.5.3.1.1: a local part longer than this may be refused by the sender's server. */
export const MAX_LOCAL_PART = 64;

/** The inbound address a business forwards its support mailbox to. */
export function inboundAddress(routingToken: string, domain: string): string {
  return `s-${routingToken}@${domain}`;
}

/** The reply-to address on mail sent from a ticket: the customer's answer threads back by it. */
export function threadAddress(routingToken: string, threadToken: string, domain: string): string {
  return `s-${routingToken}+${threadToken}@${domain}`;
}

/**
 * 12 random bytes (96 bits) — 24 hex chars, so `s-<32>+<24>` is a 59-char
 * local part, inside RFC 5321's 64. Sixteen bytes made it 67.
 */
export function newThreadToken(): string {
  return randomBytes(12).toString("hex");
}

/** The routing (and, on a reply, thread) tokens an email's addresses carry for our domain. */
export function routingFrom(
  addresses: readonly string[],
  domain: string,
): { routing: string; thread: string | null } | null {
  let found: { routing: string; thread: string | null } | null = null;
  for (const raw of addresses) {
    const m = ADDRESS_TOKEN_RE.exec(raw.trim().toLowerCase());
    if (!m || m[3] !== domain) continue;
    // A thread token wins over a bare routing address in the same mail.
    if (!found || (m[2] && !found.thread)) found = { routing: m[1]!, thread: m[2] ?? null };
  }
  return found;
}

/** The Message-IDs named by In-Reply-To and References, angle brackets kept. */
export function referencedIds(inReplyTo: string | null, references: string | null): string[] {
  const ids = `${inReplyTo ?? ""} ${references ?? ""}`.match(/<[^<>\s]+>/g) ?? [];
  return [...new Set(ids)].slice(-50);
}

/** The line the owner's list shows: the subject, or the start of the body. */
export function summaryOf(email: Pick<InboundEmail, "subject" | "text">): string {
  const subject = email.subject.trim();
  if (subject !== "") return subject.slice(0, 300);
  const body = email.text.replace(/\s+/g, " ").trim();
  return body === "" ? "(an empty email)" : body.slice(0, 300);
}

export type InboundOutcome =
  | { kind: "filed"; ticket_id: string; created: boolean; account_id: string; profile_id: string }
  | { kind: "duplicate"; ticket_id: string | null }
  | { kind: "unrouted" };

class Duplicate extends Error {}

/** File one inbound email under the business its address names. */
export async function receiveInboundEmail(
  email: InboundEmail,
  domain: string,
): Promise<InboundOutcome> {
  const [already] = await db
    .select({ ticket_id: supportEmailMessages.ticket_id })
    .from(supportEmailMessages)
    .where(eq(supportEmailMessages.provider_id, email.provider_id));
  if (already) return { kind: "duplicate", ticket_id: already.ticket_id };

  const route = routingFrom(email.to, domain);
  const [settings] = route
    ? await db
        .select()
        .from(supportSettings)
        .where(eq(supportSettings.inbound_token, route.routing))
    : [];
  if (!route || !settings) {
    // No PII: not the address, not the subject — only that it happened.
    console.log(JSON.stringify({ event: "support_inbound_unrouted", account_id: null }));
    return { kind: "unrouted" };
  }

  // The existing thread, if this is a reply.
  let ticket: typeof supportTickets.$inferSelect | null = null;
  if (route.thread) {
    const [row] = await db
      .select()
      .from(supportTickets)
      .where(
        and(
          eq(supportTickets.thread_token, route.thread),
          eq(supportTickets.profile_id, settings.profile_id),
        ),
      );
    ticket = row ?? null;
  }
  const ids = referencedIds(email.in_reply_to, email.references);
  if (!ticket && ids.length > 0) {
    const [row] = await db
      .select({ ticket: supportTickets })
      .from(supportEmailMessages)
      .innerJoin(supportTickets, eq(supportTickets.id, supportEmailMessages.ticket_id))
      .where(
        and(
          eq(supportEmailMessages.profile_id, settings.profile_id),
          inArray(supportEmailMessages.message_id_header, ids),
        ),
      )
      .orderBy(desc(supportEmailMessages.at))
      .limit(1);
    ticket = row?.ticket ?? null;
  }

  const contact = await contactForSupport({
    accountId: settings.account_id,
    email: email.from.address,
    name: email.from.name,
    source: emailedSource(email.received_at),
    at: email.received_at,
  });
  const contactId = contact.kind === "suppressed" ? null : contact.contact_id;
  const suppressed = contact.kind === "suppressed";

  try {
    const result = await db.transaction(async (tx) => {
      let ticketId: string;
      let created = false;
      if (ticket) {
        ticketId = ticket.id;
        await tx
          .update(supportTickets)
          .set({
            // Someone is waiting again.
            status: "open",
            resolved_at: null,
            ...(ticket.thread_token ? {} : { thread_token: newThreadToken() }),
            ...(ticket.contact_id || !contactId ? {} : { contact_id: contactId }),
            ...(suppressed ? { suppressed_address: true } : {}),
          })
          .where(eq(supportTickets.id, ticket.id));
      } else {
        const [row] = await tx
          .insert(supportTickets)
          .values({
            profile_id: settings.profile_id,
            account_id: settings.account_id,
            conversation_id: null,
            contact_id: contactId,
            channel: "email",
            reason: "emailed",
            summary: summaryOf(email),
            thread_token: newThreadToken(),
            suppressed_address: suppressed,
            created_at: email.received_at,
          })
          .returning({ id: supportTickets.id });
        if (!row) throw new Error("the ticket could not be recorded");
        ticketId = row.id;
        created = true;
      }
      const inserted = await tx
        .insert(supportEmailMessages)
        .values({
          ticket_id: ticketId,
          profile_id: settings.profile_id,
          account_id: settings.account_id,
          direction: "inbound",
          provider_id: email.provider_id,
          message_id_header: email.message_id,
          in_reply_to: email.in_reply_to,
          references_header: email.references,
          from_address: email.from.address,
          from_name: email.from.name,
          to_addresses: email.to,
          subject: email.subject,
          body: email.text,
          truncated: email.truncated,
          at: email.received_at,
        })
        .onConflictDoNothing()
        .returning({ id: supportEmailMessages.id });
      // The same delivery, racing itself: roll the ticket back with it.
      if (inserted.length === 0) throw new Duplicate();
      return { ticketId, created };
    });
    console.log(
      JSON.stringify({
        event: "support_inbound_filed",
        account_id: settings.account_id,
        profile_id: settings.profile_id,
        ticket_id: result.ticketId,
        created: result.created,
        contact: contact.kind,
        truncated: email.truncated,
      }),
    );
    return {
      kind: "filed",
      ticket_id: result.ticketId,
      created: result.created,
      account_id: settings.account_id,
      profile_id: settings.profile_id,
    };
  } catch (error) {
    if (error instanceof Duplicate) return { kind: "duplicate", ticket_id: null };
    throw error;
  }
}

/** A ticket's email thread, oldest first. Scoped to the profile by the caller's ticket. */
export async function emailThread(ticketId: string): Promise<EmailMessageRow[]> {
  return db
    .select()
    .from(supportEmailMessages)
    .where(eq(supportEmailMessages.ticket_id, ticketId))
    .orderBy(supportEmailMessages.at);
}

export interface TicketEmailFacts {
  /** The first inbound sender, as name (when given) and address. */
  from_name: string | null;
  from_address: string | null;
  last_inbound_at: string | null;
  last_outbound_at: string | null;
  /** The first customer email not yet followed by one of ours; null when we wrote last. */
  unanswered_since: string | null;
}

/** Per ticket on a profile: who wrote first, and the waiting clock. One query, oldest first. */
export async function ticketEmailFacts(profileId: string): Promise<Map<string, TicketEmailFacts>> {
  const rows = await db
    .select({
      ticket_id: supportEmailMessages.ticket_id,
      direction: supportEmailMessages.direction,
      from_name: supportEmailMessages.from_name,
      from_address: supportEmailMessages.from_address,
      at: supportEmailMessages.at,
    })
    .from(supportEmailMessages)
    .where(eq(supportEmailMessages.profile_id, profileId))
    .orderBy(supportEmailMessages.at);
  const facts = new Map<string, TicketEmailFacts>();
  for (const r of rows) {
    let f = facts.get(r.ticket_id);
    if (!f) {
      f = {
        from_name: null,
        from_address: null,
        last_inbound_at: null,
        last_outbound_at: null,
        unanswered_since: null,
      };
      facts.set(r.ticket_id, f);
    }
    const at = new Date(r.at).toISOString();
    if (r.direction === "inbound") {
      if (f.from_address === null) {
        f.from_name = r.from_name;
        f.from_address = r.from_address;
      }
      f.last_inbound_at = at;
      f.unanswered_since ??= at;
    } else {
      f.last_outbound_at = at;
      f.unanswered_since = null;
    }
  }
  return facts;
}
