// Support replies, from draft to sent — Phase 4 Session C (P4-10).
//
// The OWNER'S side of support (trusted; never reachable from the stranger
// tier — lib/support/structure.test.ts forbids lib/support-desk/ there).
//
//   Rule 12's covenant, extended to support: nothing goes to a customer
//   without a recorded human approval — who, when, and sha256 of the
//   exact text that will be sent. What is sent is exactly that text.
//
//   Rule 20 (and rule 17's no-disable pattern): a reply the assistant
//   drafted carries a disclosure line, appended HERE at approval time.
//   The owner edits the body; the disclosure is not part of the body, so
//   there is nothing to edit or remove. A reply the owner wrote from
//   scratch carries none. ai_drafted stays true however much a draft is
//   edited — it records who started the words.
//
//   At most once: approved → sending is claimed atomically BEFORE Resend
//   is called, and a "sending" row is never retried by anything. If the
//   outcome is unknown, it stays "sending" and the ticket says so.
//
//   At send time, again: the emergency stop (its table, read directly —
//   the engine module drags the whole execution registry with it), the
//   key, and the transactional gate (suppression; consent gradation does
//   not apply to a reply to the customer's own question — rule 19's
//   lib/crm gate). With no RESEND_API_KEY nothing sends and nothing
//   pretends: the reply stays approved and says "Not sent: email isn't
//   set up yet".

import { createHash } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "../../db";
import {
  contacts,
  decisionLog,
  executionHalts,
  supportEmailMessages,
  supportReplies,
  supportTickets,
} from "../../db/schema";
import { canEmailTransactional, isSuppressed } from "../crm/contacts";
import { resendApiKey, supportInboundDomain } from "../env";
import { businessCustomerLocale } from "../i18n/people";
import type { Words } from "../i18n/recipient";
import { englishWords, wordsFor } from "../i18n/recipient";
import { newThreadToken, replyThreadHeaders, threadAddress } from "../support/email-tickets";
import { settingsForProfile } from "../support/settings";
import type { MailFetch } from "./mailer";
import { replyDisclosure } from "./disclosure";
import { sendSupportEmail } from "./mailer";

export type ReplyRow = typeof supportReplies.$inferSelect;
type TicketRow = typeof supportTickets.$inferSelect;

export const REPLY_MAX_CHARS = 5000;

export class ReplyError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "ReplyError";
    this.status = status;
  }
}

/* ── the disclosure (rule 20) ── */

export { replyDisclosure };

/** Exactly what goes out: the owner's words, plus the disclosure when the assistant drafted them. */
export function textToSend(body: string, aiDrafted: boolean, businessName: string): string {
  const words = body.replace(/\r\n?/g, "\n").trim();
  return aiDrafted ? `${words}\n\n--\n${replyDisclosure(businessName)}` : words;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/* ── who a reply goes to ── */

export interface ReplyTarget {
  address: string;
  contact_id: string | null;
  /** The customer's latest email on the ticket, for threading. Null on a chat ticket. */
  last_inbound: typeof supportEmailMessages.$inferSelect | null;
}

/** The address a ticket's reply would go to, or null: no way to reach this customer. */
export async function replyTarget(ticket: TicketRow): Promise<ReplyTarget | null> {
  const [lastInbound] = await db
    .select()
    .from(supportEmailMessages)
    .where(
      and(
        eq(supportEmailMessages.ticket_id, ticket.id),
        eq(supportEmailMessages.direction, "inbound"),
      ),
    )
    .orderBy(desc(supportEmailMessages.at))
    .limit(1);
  if (ticket.contact_id) {
    const [contact] = await db
      .select({ email: contacts.email })
      .from(contacts)
      .where(eq(contacts.id, ticket.contact_id));
    if (contact?.email) {
      return {
        address: contact.email,
        contact_id: ticket.contact_id,
        last_inbound: lastInbound ?? null,
      };
    }
  }
  if (lastInbound) {
    return { address: lastInbound.from_address, contact_id: null, last_inbound: lastInbound };
  }
  return null;
}

/* ── reading ── */

async function ownedTicket(profileId: string, ticketId: string): Promise<TicketRow> {
  const [ticket] = await db
    .select()
    .from(supportTickets)
    .where(and(eq(supportTickets.id, ticketId), eq(supportTickets.profile_id, profileId)));
  if (!ticket) throw new ReplyError("no such ticket", 404);
  return ticket;
}

async function ownedReply(profileId: string, replyId: string): Promise<ReplyRow> {
  const [reply] = await db
    .select()
    .from(supportReplies)
    .where(and(eq(supportReplies.id, replyId), eq(supportReplies.profile_id, profileId)));
  if (!reply) throw new ReplyError("no such reply", 404);
  return reply;
}

export async function repliesFor(profileId: string, ticketId: string): Promise<ReplyRow[]> {
  return db
    .select()
    .from(supportReplies)
    .where(and(eq(supportReplies.ticket_id, ticketId), eq(supportReplies.profile_id, profileId)))
    .orderBy(supportReplies.created_at);
}

/** The reply in flight on a ticket (drafted, approved or sending), if any. */
export async function liveReply(ticketId: string): Promise<ReplyRow | null> {
  const [row] = await db
    .select()
    .from(supportReplies)
    .where(
      and(
        eq(supportReplies.ticket_id, ticketId),
        inArray(supportReplies.status, ["drafted", "approved", "sending"]),
      ),
    );
  return row ?? null;
}

function cleanBody(body: string): string {
  const words = body.replace(/\r\n?/g, "\n").trim();
  if (words === "") throw new ReplyError("write the reply first", 422);
  if (words.length > REPLY_MAX_CHARS) {
    throw new ReplyError(`keep a reply under ${REPLY_MAX_CHARS} characters`, 422);
  }
  return words;
}

/* ── writing ── */

/**
 * The owner's own words: a new reply written from scratch (ai_drafted
 * false), or an edit of the reply in flight (ai_drafted unchanged).
 */
export async function saveReplyText(
  profileId: string,
  ticketId: string,
  body: string,
): Promise<ReplyRow> {
  const ticket = await ownedTicket(profileId, ticketId);
  const words = cleanBody(body);
  const live = await liveReply(ticket.id);
  if (live) {
    if (live.status !== "drafted")
      throw new ReplyError(`this reply is already ${live.status}`, 409);
    const [row] = await db
      .update(supportReplies)
      .set({ body: words })
      .where(and(eq(supportReplies.id, live.id), eq(supportReplies.status, "drafted")))
      .returning();
    if (!row) throw new ReplyError("this reply changed while you were editing it", 409);
    return row;
  }
  if (!(await replyTarget(ticket))) {
    throw new ReplyError("there's no address to reply to on this ticket", 409);
  }
  const [row] = await db
    .insert(supportReplies)
    .values({
      ticket_id: ticket.id,
      profile_id: ticket.profile_id,
      account_id: ticket.account_id,
      ai_drafted: false,
      body: words,
    })
    .returning();
  if (!row) throw new ReplyError("the reply could not be saved", 500);
  return row;
}

/** The assistant's draft lands here (./draft.ts) — never sent, never approved. */
export async function insertDraft(args: {
  ticket: TicketRow;
  text: string;
  groundedOn: string[];
  costEur: number;
}): Promise<ReplyRow> {
  const words = cleanBody(args.text);
  const [row] = await db
    .insert(supportReplies)
    .values({
      ticket_id: args.ticket.id,
      profile_id: args.ticket.profile_id,
      account_id: args.ticket.account_id,
      ai_drafted: true,
      drafted_text: words,
      body: words,
      grounded_on: args.groundedOn,
      draft_cost_eur: args.costEur.toFixed(6),
    })
    .returning();
  if (!row) throw new ReplyError("the draft could not be saved", 500);
  return row;
}

/* ── the decision (rule 12) ── */

function logHash(kind: "reply_approval" | "reply_decline" | "reply_send", payload: object): string {
  return sha256(JSON.stringify({ kind, ...payload }));
}

/**
 * Approve the exact words the owner is looking at. The body is saved and
 * the reply approved in one statement, conditional on it still being a
 * draft; the text to send (with the disclosure when the assistant drafted
 * it) is fixed here and hashed, and the log records ids and the hash.
 */
export async function approveReply(args: {
  profileId: string;
  replyId: string;
  userId: string;
  body: string;
  now?: Date;
}): Promise<ReplyRow> {
  const reply = await ownedReply(args.profileId, args.replyId);
  if (reply.status !== "drafted")
    throw new ReplyError(`this reply is already ${reply.status}`, 409);
  const settings = await settingsForProfile(args.profileId);
  if (!settings) throw new ReplyError("support isn't enabled for this business", 409);
  const words = cleanBody(args.body);
  const sent_text = textToSend(words, reply.ai_drafted, settings.business_name);
  const sent_text_sha256 = sha256(sent_text);
  const at = (args.now ?? new Date()).toISOString();
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(supportReplies)
      .set({
        status: "approved",
        body: words,
        sent_text,
        sent_text_sha256,
        approved_by: args.userId,
        approved_at: at,
        outcome_note: null,
      })
      .where(and(eq(supportReplies.id, reply.id), eq(supportReplies.status, "drafted")))
      .returning();
    if (!row) throw new ReplyError("this reply was decided a moment ago", 409);
    await tx.insert(decisionLog).values({
      profile_id: row.profile_id,
      actor: "owner",
      user_id: args.userId,
      kind: "reply_approval",
      ref_id: row.id,
      payload_hash: logHash("reply_approval", {
        reply_id: row.id,
        ticket_id: row.ticket_id,
        approved_by: args.userId,
        approved_at: at,
        ai_drafted: row.ai_drafted,
        sent_text_sha256,
      }),
    });
    return row;
  });
}

export async function declineReply(args: {
  profileId: string;
  replyId: string;
  userId: string;
  now?: Date;
}): Promise<ReplyRow> {
  const reply = await ownedReply(args.profileId, args.replyId);
  if (reply.status !== "drafted")
    throw new ReplyError(`this reply is already ${reply.status}`, 409);
  const at = (args.now ?? new Date()).toISOString();
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(supportReplies)
      .set({ status: "declined", declined_at: at })
      .where(and(eq(supportReplies.id, reply.id), eq(supportReplies.status, "drafted")))
      .returning();
    if (!row) throw new ReplyError("this reply was decided a moment ago", 409);
    await tx.insert(decisionLog).values({
      profile_id: row.profile_id,
      actor: "owner",
      user_id: args.userId,
      kind: "reply_decline",
      ref_id: row.id,
      payload_hash: logHash("reply_decline", {
        reply_id: row.id,
        ticket_id: row.ticket_id,
        declined_by: args.userId,
        declined_at: at,
        body_sha256: sha256(row.body),
      }),
    });
    return row;
  });
}

/* ── sending ── */

export const NOT_SET_UP = "Not sent: email isn't set up yet.";
export const STOPPED =
  "Not sent: everything is stopped (the emergency stop is on). It stays approved; it sends when you resume and send it.";
export const MAYBE_SENT =
  "I may have sent this: the email service didn't confirm either way. I won't send it again by myself. Check your sent mail, or ask the customer, before you write again.";

export interface SendOutcome {
  status: ReplyRow["status"];
  note: string | null;
}

/** "Fernhill Ceramics via SYB <support@…>": our verified sending address, their name. */
function fromHeader(businessName: string): string {
  const raw = process.env.EMAIL_FROM?.trim() || "ScaleX <onboarding@resend.dev>";
  const address = /<([^<>]+)>\s*$/.exec(raw)?.[1] ?? raw;
  const name = businessName.replace(/["<>\r\n\\]/g, "").trim() || "Support";
  return `"${name} via ScaleX" <${address.trim()}>`;
}

/**
 * The reply's subject: theirs with "Re:", or — when they gave none — ours, in
 * the business's language (L-6: the customer reads the business's language).
 */
function subjectFor(
  last: ReplyTarget["last_inbound"],
  businessName: string,
  w: Words = englishWords("emails.supportReply"),
): string {
  const s = last?.subject.trim() ?? "";
  if (s === "") return w.t("subject", { business: businessName });
  return /^re:/i.test(s) ? s : `Re: ${s}`;
}

async function note(replyId: string, text: string): Promise<void> {
  await db.update(supportReplies).set({ outcome_note: text }).where(eq(supportReplies.id, replyId));
}

/**
 * Send an approved reply, once. THE ONLY CALLER is the owner's approve
 * route (app/api/support/route.ts), behind the owner's session — a source
 * scan in replies.test.ts fails the build otherwise.
 */
export async function sendApprovedReply(args: {
  profileId: string;
  replyId: string;
  fetchImpl?: MailFetch;
  now?: () => Date;
}): Promise<SendOutcome> {
  const now = args.now ?? (() => new Date());
  const reply = await ownedReply(args.profileId, args.replyId);
  if (reply.status !== "approved") {
    return { status: reply.status, note: reply.outcome_note };
  }
  const refuse = async (text: string): Promise<SendOutcome> => {
    await note(reply.id, text);
    console.log(
      JSON.stringify({
        event: "support_reply_not_sent",
        account_id: reply.account_id,
        reply_id: reply.id,
        why: text.slice(0, 60),
      }),
    );
    return { status: "approved", note: text };
  };

  // 1. The emergency stop outranks everything (rule 15).
  const [halt] = await db
    .select({ account_id: executionHalts.account_id })
    .from(executionHalts)
    .where(eq(executionHalts.account_id, reply.account_id));
  if (halt) return refuse(STOPPED);

  // 2. Never pretend: no key, or nowhere for their answer to come back to.
  const apiKey = resendApiKey();
  const domain = supportInboundDomain();
  if (!apiKey || !domain) return refuse(NOT_SET_UP);

  // 3. Who, and the transactional gate — suppression binds even here.
  const ticket = await ownedTicket(args.profileId, reply.ticket_id);
  const target = await replyTarget(ticket);
  if (!target) return refuse("Not sent: there's no address to reply to on this ticket.");
  if (target.contact_id) {
    const [contact] = await db.select().from(contacts).where(eq(contacts.id, target.contact_id));
    const permission = contact
      ? await canEmailTransactional(contact)
      : { allowed: false, reason: "the contact is gone" };
    if (!permission.allowed) return refuse(`Not sent: the gate refused it, ${permission.reason}.`);
  } else {
    const suppressed = await isSuppressed(reply.account_id, target.address);
    if (suppressed) return refuse(`Not sent: the gate refused it, suppressed (${suppressed}).`);
  }
  const settings = await settingsForProfile(args.profileId);
  if (!settings) return refuse("Not sent: support isn't enabled for this business.");
  const threadToken = ticket.thread_token ?? newThreadToken();
  if (!ticket.thread_token) {
    await db
      .update(supportTickets)
      .set({ thread_token: threadToken })
      .where(eq(supportTickets.id, ticket.id));
  }

  // 4. Claim — approved → sending — before anything is sent. Lose the race, send nothing.
  const [claimed] = await db
    .update(supportReplies)
    .set({ status: "sending", claimed_at: now().toISOString(), outcome_note: null })
    .where(and(eq(supportReplies.id, reply.id), eq(supportReplies.status, "approved")))
    .returning();
  if (!claimed || !claimed.sent_text || !claimed.sent_text_sha256) {
    const [cur] = await db.select().from(supportReplies).where(eq(supportReplies.id, reply.id));
    return { status: cur?.status ?? "approved", note: cur?.outcome_note ?? null };
  }

  // What goes out is exactly the approved text: checked against its hash, not assumed.
  if (sha256(claimed.sent_text) !== claimed.sent_text_sha256) {
    await db
      .update(supportReplies)
      .set({
        status: "failed",
        outcome_note: "Not sent: the text no longer matches what you approved.",
      })
      .where(eq(supportReplies.id, reply.id));
    return { status: "failed", note: "Not sent: the text no longer matches what you approved." };
  }

  const last = target.last_inbound;
  // Rebuilt from validated ids, never the stored headers copied (review 2026-10-23, #17).
  const { in_reply_to: inReplyTo, references } = replyThreadHeaders(last);
  const subject = subjectFor(
    last,
    settings.business_name,
    await wordsFor(await businessCustomerLocale(args.profileId), "emails.supportReply"),
  );
  const outcome = await sendSupportEmail(
    {
      from: fromHeader(settings.business_name),
      to: target.address,
      reply_to: threadAddress(settings.inbound_token, threadToken, domain),
      subject,
      text: claimed.sent_text,
      in_reply_to: inReplyTo,
      references,
      idempotency_key: `syb-support-reply-${claimed.id}`,
    },
    apiKey,
    args.fetchImpl,
  );

  const at = now().toISOString();
  const log = (result: string, providerId: string | null) =>
    db.insert(decisionLog).values({
      profile_id: claimed.profile_id,
      actor: "system",
      kind: "reply_send",
      ref_id: claimed.id,
      payload_hash: logHash("reply_send", {
        reply_id: claimed.id,
        ticket_id: claimed.ticket_id,
        result,
        provider_id: providerId,
        sent_text_sha256: claimed.sent_text_sha256,
        at,
      }),
    });
  console.log(
    JSON.stringify({
      event: "support_reply_send",
      account_id: claimed.account_id,
      reply_id: claimed.id,
      ticket_id: claimed.ticket_id,
      outcome: outcome.kind,
      ...(outcome.kind === "refused" ? { status: outcome.status } : {}),
    }),
  );

  if (outcome.kind === "sent") {
    await db.transaction(async (tx) => {
      await tx
        .update(supportReplies)
        .set({ status: "sent", sent_at: at, provider_id: outcome.provider_id, outcome_note: null })
        .where(eq(supportReplies.id, claimed.id));
      await tx.insert(supportEmailMessages).values({
        ticket_id: claimed.ticket_id,
        profile_id: claimed.profile_id,
        account_id: claimed.account_id,
        direction: "outbound",
        provider_id: outcome.provider_id,
        in_reply_to: inReplyTo,
        references_header: references,
        from_address: fromHeader(settings.business_name),
        to_addresses: [target.address],
        subject,
        body: claimed.sent_text!,
        at,
      });
    });
    await log("sent", outcome.provider_id);
    return { status: "sent", note: null };
  }
  if (outcome.kind === "refused") {
    const text = `Not sent: the email service refused it (${outcome.status}${outcome.message ? `: ${outcome.message}` : ""}). Nothing went out: write it again to retry.`;
    await db
      .update(supportReplies)
      .set({ status: "failed", outcome_note: text })
      .where(eq(supportReplies.id, claimed.id));
    await log("refused", null);
    return { status: "failed", note: text };
  }
  // Unknown: it stays "sending", forever unless a person says otherwise. Never retried.
  await note(claimed.id, MAYBE_SENT);
  await log("unknown", null);
  return { status: "sending", note: MAYBE_SENT };
}
