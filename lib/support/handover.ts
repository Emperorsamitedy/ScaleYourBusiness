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
// Stranger-facing (rule 21): lib/support and the database only.

import { and, desc, eq } from "drizzle-orm";
import { db } from "../../db";
import { supportTickets } from "../../db/schema";
import { SupportError, conversationByToken } from "./chat";
import { isEmailAddress } from "./inbound";
import { chatAddressSource, contactForSupport, normaliseAddress } from "./support-contact";

export const ADDRESS_SAVED =
  "Thanks — a person will reply to that address. It's used only to answer this question, not for marketing.";

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
  const [ticket] = await db
    .select()
    .from(supportTickets)
    .where(
      and(eq(supportTickets.conversation_id, conversation.id), eq(supportTickets.status, "open")),
    )
    .orderBy(desc(supportTickets.created_at))
    .limit(1);
  if (!ticket) {
    throw new SupportError("nothing here is waiting for a person yet — ask for one first", 409);
  }
  if (ticket.contact_id || ticket.suppressed_address) {
    throw new SupportError("I already have an address for this question", 409);
  }
  const at = now.toISOString();
  const contact = await contactForSupport({
    accountId: conversation.account_id,
    email,
    name: null,
    source: chatAddressSource(at),
    at,
  });
  await db
    .update(supportTickets)
    .set(
      contact.kind === "suppressed"
        ? { suppressed_address: true }
        : { contact_id: contact.contact_id },
    )
    .where(eq(supportTickets.id, ticket.id));
  console.log(
    JSON.stringify({
      event: "support_address_left",
      account_id: conversation.account_id,
      conversation_id: conversation.id,
      ticket_id: ticket.id,
      contact: contact.kind,
    }),
  );
  return { message: ADDRESS_SAVED };
}
