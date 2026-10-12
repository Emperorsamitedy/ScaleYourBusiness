// Escalations — Phase 4 Session B (P4-06), rule 21.
//
// A support conversation can create exactly ONE thing: a ticket asking
// a human to step in. The reason is a closed set so the owner's screen
// can say why; the summary is the customer's last question verbatim,
// which is what the human is being asked to answer. One open ticket per
// conversation — asking twice does not queue twice.
//
// Resolving is the owner's act and lives here too: it writes this one
// table and nothing else, so the module stays on the stranger-safe side
// of the line.

import { and, desc, eq } from "drizzle-orm";
import { db } from "../../db";
import { supportTickets } from "../../db/schema";

export type TicketRow = typeof supportTickets.$inferSelect;
export type TicketReason = TicketRow["reason"];

export class TicketError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "TicketError";
    this.status = status;
  }
}

export async function openTicketForConversation(args: {
  profileId: string;
  accountId: string;
  conversationId: string;
  reason: TicketReason;
  summary: string;
}): Promise<{ ticket: TicketRow; created: boolean }> {
  const [existing] = await db
    .select()
    .from(supportTickets)
    .where(
      and(
        eq(supportTickets.conversation_id, args.conversationId),
        eq(supportTickets.status, "open"),
      ),
    )
    .limit(1);
  if (existing) return { ticket: existing, created: false };
  const [ticket] = await db
    .insert(supportTickets)
    .values({
      profile_id: args.profileId,
      account_id: args.accountId,
      conversation_id: args.conversationId,
      reason: args.reason,
      summary: args.summary.slice(0, 2000),
    })
    .returning();
  if (!ticket) throw new TicketError("the escalation could not be recorded", 500);
  console.log(
    JSON.stringify({
      event: "support_ticket_opened",
      account_id: args.accountId,
      profile_id: args.profileId,
      conversation_id: args.conversationId,
      ticket_id: ticket.id,
      reason: args.reason,
    }),
  );
  return { ticket, created: true };
}

/** The owner's view: open first, newest first. */
export async function listTickets(profileId: string): Promise<TicketRow[]> {
  return db
    .select()
    .from(supportTickets)
    .where(eq(supportTickets.profile_id, profileId))
    .orderBy(desc(supportTickets.created_at));
}

export async function resolveTicket(
  profileId: string,
  ticketId: string,
  status: "answered" | "closed",
): Promise<TicketRow> {
  const [row] = await db
    .update(supportTickets)
    .set({ status, resolved_at: new Date().toISOString() })
    .where(
      and(
        eq(supportTickets.id, ticketId),
        eq(supportTickets.profile_id, profileId),
        eq(supportTickets.status, "open"),
      ),
    )
    .returning();
  if (!row) throw new TicketError("no such open ticket", 404);
  return row;
}
