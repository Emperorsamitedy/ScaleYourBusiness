// "Leave your address and a person will reply" — Phase 4 Session C (P4-11).
//
// After the widget hands a conversation to a person, the customer MAY
// give an email address so the reply can reach them. It is optional, it
// is used only to answer this question, and it becomes a consent-"unsure"
// contact through the same path as an emailed-in stranger (rule 19). A
// suppressed address is not recreated: the ticket is marked so the owner
// sees that replies are refused, and the customer is told the same thing
// as anyone else — whether an address was ever erased is not something a
// stranger can find out here.
//
// Review 2026-10-23 (#19): one address per ticket, held under concurrency —
// the ticket row is locked, re-checked, and written conditionally
// (`WHERE contact_id IS NULL`) in one transaction with the contact write,
// so parallel posts create one contact, not one each. And it is
// rate-limited like the widget's `start`: per business per day, and per
// visitor (the conversation's day-scoped client hash).
//
// The address is typed, never verified: the owner's screen says so
// ("given in chat, not verified").
//
// Stranger-facing (rule 21): lib/support and the database only.

import { and, desc, eq, gte, isNotNull, isNull, or, sql } from "drizzle-orm";
import { db } from "../../db";
import { supportConversations, supportTickets } from "../../db/schema";
import { SupportError, conversationByToken } from "./chat";
import { isEmailAddress } from "./inbound";
import {
  chatAddressSource,
  contactForSupport,
  lockSupportWrites,
  normaliseAddress,
} from "./support-contact";

export const ADDRESS_SAVED =
  "Thanks — a person will reply to that address. It's used only to answer this question, not for marketing.";

/** Addresses a business's widget takes in a day (each one a contact row). */
export const SUPPORT_MAX_ADDRESSES_PER_DAY = 100;
/** One visitor's share of that, by the conversation's day-scoped client hash. */
export const SUPPORT_MAX_ADDRESSES_PER_CLIENT_PER_DAY = 3;

const TOO_MANY = "I can't take more addresses right now — please try again tomorrow";

export async function leaveAddress(
  token: string,
  rawEmail: string,
  now: Date = new Date(),
): Promise<{ message: string }> {
  const conversation = await conversationByToken(token);
  if (!conversation) throw new SupportError("no such conversation", 404);
  const email = normaliseAddress(rawEmail);
  if (email.length > 254 || !isEmailAddress(email)) {
    throw new SupportError("that doesn't look like an email address", 422);
  }
  const at = now.toISOString();
  const today = `${at.slice(0, 10)}T00:00:00.000Z`;
  const hasAddress = or(
    isNotNull(supportTickets.contact_id),
    eq(supportTickets.suppressed_address, true),
  );

  const outcome = await db.transaction(async (tx) => {
    // Serialised against an erasure of this address: see lockSupportWrites.
    await lockSupportWrites(tx, conversation.account_id);
    // Locked: a second post for the same ticket waits here, then sees the first one's address.
    const [ticket] = await tx
      .select()
      .from(supportTickets)
      .where(
        and(eq(supportTickets.conversation_id, conversation.id), eq(supportTickets.status, "open")),
      )
      .orderBy(desc(supportTickets.created_at))
      .limit(1)
      .for("update");
    if (!ticket) {
      throw new SupportError("nothing here is waiting for a person yet — ask for one first", 409);
    }
    if (ticket.contact_id || ticket.suppressed_address) {
      throw new SupportError("I already have an address for this question", 409);
    }

    const [business] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(supportTickets)
      .where(
        and(
          eq(supportTickets.profile_id, ticket.profile_id),
          eq(supportTickets.channel, "chat"),
          gte(supportTickets.created_at, today),
          hasAddress,
        ),
      );
    if ((business?.n ?? 0) >= SUPPORT_MAX_ADDRESSES_PER_DAY) throw new SupportError(TOO_MANY, 429);
    if (conversation.client_hash) {
      const [mine] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(supportTickets)
        .innerJoin(
          supportConversations,
          eq(supportConversations.id, supportTickets.conversation_id),
        )
        .where(
          and(
            eq(supportTickets.profile_id, ticket.profile_id),
            eq(supportConversations.client_hash, conversation.client_hash),
            hasAddress,
          ),
        );
      if ((mine?.n ?? 0) >= SUPPORT_MAX_ADDRESSES_PER_CLIENT_PER_DAY) {
        throw new SupportError(TOO_MANY, 429);
      }
    }

    const contact = await contactForSupport(
      {
        accountId: conversation.account_id,
        email,
        name: null,
        source: chatAddressSource(at),
        at,
        // A typed address is never verified; it is labelled so on the owner's screen instead.
        linkExisting: true,
      },
      tx,
    );
    if (contact.kind === "unlinked") throw new Error("a chat address always links");
    const [updated] = await tx
      .update(supportTickets)
      .set(
        contact.kind === "suppressed"
          ? { suppressed_address: true }
          : { contact_id: contact.contact_id },
      )
      .where(
        and(
          eq(supportTickets.id, ticket.id),
          isNull(supportTickets.contact_id),
          eq(supportTickets.suppressed_address, false),
        ),
      )
      .returning({ id: supportTickets.id });
    // Belt and braces behind the lock: never overwrite an address, and roll the contact back with it.
    if (!updated) throw new SupportError("I already have an address for this question", 409);
    return { ticket_id: ticket.id, contact: contact.kind };
  });

  console.log(
    JSON.stringify({
      event: "support_address_left",
      account_id: conversation.account_id,
      conversation_id: conversation.id,
      ticket_id: outcome.ticket_id,
      contact: outcome.contact,
    }),
  );
  return { message: ADDRESS_SAVED };
}
