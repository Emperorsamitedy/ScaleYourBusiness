// The OWNER'S support API — Phase 4 Sessions B and D (P4-05..07, P4-12).
//
//   GET  /api/support                         settings, knowledge, tickets, conversations
//   GET  /api/support?conversation=<id>       one transcript
//   GET  /api/support?ticket=<id>             one ticket's email thread (P4-09)
//   POST /api/support {action}                enable | rotate | rotate_inbound |
//                                             set_reply_hours | set_notify |
//                                             propose_knowledge | propose_custom |
//                                             publish | retire | resolve_ticket |
//                                             erase_conversation | erase_ticket |
//                                             cluster_faq | draft_reply | save_reply |
//                                             approve_reply | send_reply | decline_reply
//
// P4-10: approve_reply and send_reply are the ONLY path by which a reply
// reaches a customer — one call site of sendApprovedReply, after the
// signed-in check below (a source scan in lib/support-desk holds it).
//
// Reading needs the intake cookie like every profile surface. Every
// mutation needs a signed-in user: publishing puts words in the
// assistant's mouth, rotating a key cuts every embedded widget off, and
// clustering spends a model call.
//
// L-4c (TASKS-LANGUAGES.md): what this API says to the owner — refusals,
// the draft refusal, a send's outcome note, a knowledge proposal's summary —
// is in the request's language ("supportWords", lib/support-desk/words).
// Stored rows keep their English; English readers get exactly what the API
// always sent. What a customer reads is not here (L-5/L-6).

import { logSafeError } from "../../../lib/core/log-safe";
import { matchingSession, resolveAccess } from "../../../lib/auth/access";
import { appOriginOf, isSameOriginPost } from "../../../lib/auth/same-origin";
import { type NextRequest, NextResponse } from "next/server";
import {
  ContactError,
  eraseConversation,
  eraseTicket,
  isSuppressed,
} from "../../../lib/crm/contacts";
import { FaqError, clusterQuestions } from "../../../lib/crm/faq";
import {
  KnowledgeError,
  listKnowledge,
  proposeCustomKnowledge,
  proposeKnowledgeEntries,
  publishKnowledgeFromProposal,
  publishableKnowledgeProposals,
  retireKnowledgeEntry,
} from "../../../lib/crm/knowledge";
import {
  SupportSettingsError,
  ensureSupportSettings,
  rotateInboundToken,
  setNotifyOwner,
  setReplyHours,
  rotateSiteKey,
} from "../../../lib/crm/support-settings";
import { supportInboundDomain } from "../../../lib/env";
import { ProposalError } from "../../../lib/proposals/service";
import {
  SupportError,
  listConversations,
  readConversationForOwner,
} from "../../../lib/support/chat";
import { inArray } from "drizzle-orm";
import { db } from "../../../db";
import { contacts } from "../../../db/schema";
import { keysInWords, loadEntityNames } from "../../../lib/profile/factsheet";
import {
  emailThread,
  inboundAddress,
  senderNote,
  ticketEmailFacts,
} from "../../../lib/support/email-tickets";
import { draftReply } from "../../../lib/support-desk/draft";
import {
  ReplyError,
  approveReply,
  declineReply,
  repliesFor,
  replyTarget,
  saveReplyText,
  sendApprovedReply,
} from "../../../lib/support-desk/replies";
import { settingsForProfile } from "../../../lib/support/settings";
import { widgetSnippet } from "../../../lib/support/snippet";
import { TicketError, listTickets, resolveTicket } from "../../../lib/support/tickets";
import { requireRole } from "../../../lib/auth/roles";
import type { RoleAction } from "../../../lib/auth/roles";
import type { AppLocale } from "../../../lib/i18n/locales";
import { requestTr } from "../../../lib/i18n/request-tr";
import type { Tr } from "../../../lib/i18n/tr";
import { orList } from "../../../lib/crm/words";
import {
  SUPPORT_WORDS,
  draftRefusalWords,
  knowledgeSummaryWords,
  outcomeNoteWords,
  supportErrorWords,
} from "../../../lib/support-desk/words";

async function resolveProfile(): Promise<string | null> {
  // The one door (lib/auth/access): a signed cookie, and an owned business only for its own account.
  return (await resolveAccess())?.profile_id ?? null;
}

function onError(error: unknown, tr: Tr, locale: AppLocale): NextResponse {
  if (
    error instanceof KnowledgeError ||
    error instanceof SupportSettingsError ||
    error instanceof SupportError ||
    error instanceof TicketError ||
    error instanceof FaqError ||
    error instanceof ProposalError ||
    error instanceof ContactError ||
    error instanceof ReplyError
  ) {
    return NextResponse.json(
      { error: supportErrorWords(error.message, tr, locale) },
      { status: error.status },
    );
  }
  console.error(JSON.stringify({ event: "support_error", ...logSafeError(error) }));
  return NextResponse.json({ error: tr("error.server") }, { status: 500 });
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const profileId = await resolveProfile();
  if (!profileId) return NextResponse.json({ error: "no intake session" }, { status: 401 });
  const { tr, locale } = await requestTr(SUPPORT_WORDS);
  try {
    const ticketId = request.nextUrl.searchParams.get("ticket");
    if (ticketId) {
      const ticket = (await listTickets(profileId)).find((t) => t.id === ticketId);
      if (!ticket) return NextResponse.json({ error: tr("error.noTicket") }, { status: 404 });
      const thread = await emailThread(ticket.id);
      const target = await replyTarget(ticket);
      return NextResponse.json({
        reachable: target !== null,
        replies: (await repliesFor(profileId, ticket.id)).map((r) => ({
          id: r.id,
          status: r.status,
          ai_drafted: r.ai_drafted,
          body: r.body,
          sent_text: r.sent_text,
          approved_at: r.approved_at,
          sent_at: r.sent_at,
          outcome_note: outcomeNoteWords(r.outcome_note, tr, locale),
          created_at: r.created_at,
        })),
        emails: thread.map((m) => ({
          id: m.id,
          direction: m.direction,
          from_address: m.from_address,
          from_name: m.from_name,
          subject: m.subject,
          body: m.body,
          truncated: m.truncated,
          // Review #18: an inbound sender who didn't pass authentication says so.
          sender_verified: m.direction === "inbound" ? m.sender_auth === "verified" : null,
          at: m.at,
        })),
      });
    }
    const conversationId = request.nextUrl.searchParams.get("conversation");
    if (conversationId) {
      return NextResponse.json({
        messages: await readConversationForOwner(profileId, conversationId),
      });
    }
    const [settings, knowledge, publishable, tickets, conversations] = await Promise.all([
      settingsForProfile(profileId),
      listKnowledge(profileId),
      publishableKnowledgeProposals(profileId),
      listTickets(profileId),
      listConversations(profileId),
    ]);
    const entityNames = await loadEntityNames(
      profileId,
      knowledge.flatMap((e) => e.source_keys.map((k) => k.split(".")[1] ?? "")),
    );
    const origin = process.env.APP_URL?.replace(/\/$/, "") || request.nextUrl.origin;
    const domain = supportInboundDomain();
    // Who each ticket is from, whether anyone can reply, and when they last wrote.
    const facts = await ticketEmailFacts(profileId);
    const contactIds = tickets.map((t) => t.contact_id).filter((id): id is string => id !== null);
    const people = new Map(
      (contactIds.length > 0
        ? await db
            .select({ id: contacts.id, name: contacts.name, email: contacts.email })
            .from(contacts)
            .where(inArray(contacts.id, contactIds))
        : []
      ).map((c) => [c.id, c]),
    );
    const shaped = [];
    for (const t of tickets) {
      const f = facts.get(t.id);
      const person = t.contact_id ? people.get(t.contact_id) : undefined;
      const address = person?.email ?? f?.from_address ?? null;
      // Read now, not only at filing: an unsubscribe since then binds too.
      const refused =
        t.suppressed_address ||
        (address !== null && (await isSuppressed(t.account_id, address)) !== null);
      shaped.push({
        id: t.id,
        conversation_id: t.conversation_id,
        contact_id: t.contact_id,
        channel: t.channel,
        reason: t.reason,
        summary: t.summary,
        status: t.status,
        answer: t.answer,
        created_at: t.created_at,
        suppressed_address: refused,
        from: person?.name ?? f?.from_name ?? address,
        has_address: address !== null,
        // Review #18: "sender not verified" / "given in chat, not verified", or null.
        sender_note: senderNote({
          channel: t.channel,
          has_address: address !== null || t.suppressed_address,
          from_auth: f?.from_auth ?? null,
        }),
        // P4-11's waited clock: from the first word of theirs we haven't answered.
        // A ticket with no email side waits from when it was handed over.
        waiting_since: f ? f.unanswered_since : t.created_at,
        last_reply_at: f?.last_outbound_at ?? null,
      });
    }
    return NextResponse.json({
      settings: settings
        ? {
            site_key: settings.site_key,
            business_name: settings.business_name,
            rotated_at: settings.rotated_at,
            snippet: widgetSnippet(origin, settings.site_key),
            inbound_address: domain ? inboundAddress(settings.inbound_token, domain) : null,
            inbound_rotated_at: settings.inbound_rotated_at,
            reply_hours: settings.reply_hours,
            reply_hours_set_at: settings.reply_hours_set_at,
            notify_owner: settings.notify_owner,
          }
        : null,
      // Where each answer came from, in words: entity names, never their ids.
      knowledge: knowledge.map((e) => ({
        ...e,
        source_words: keysInWords(e.source_keys, entityNames),
      })),
      publishable: publishable.map((p) => ({
        id: p.id,
        summary: knowledgeSummaryWords(
          (p.action as { summary?: string }).summary ?? "knowledge proposal",
          tr,
          locale,
        ),
      })),
      tickets: shaped,
      conversations,
    });
  } catch (error) {
    return onError(error, tr, locale);
  }
}

/** Idea 52: the role each action needs (lib/auth/roles); an action not listed asks for an owner. */
const SUPPORT_ROLE: Record<string, RoleAction> = {
  enable: "support.settings",
  rotate: "support.settings",
  rotate_inbound: "support.settings",
  set_reply_hours: "support.settings",
  set_notify: "support.settings",
  erase_ticket: "erasure.run",
  erase_conversation: "erasure.run",
  propose_knowledge: "proposals.generate",
  propose_custom: "proposals.generate",
  cluster_faq: "proposals.generate",
  publish: "support.answer",
  retire: "support.answer",
  resolve_ticket: "support.answer",
  draft_reply: "support.answer",
  save_reply: "support.answer",
  approve_reply: "support.answer",
  send_reply: "support.answer",
  decline_reply: "support.answer",
};

/** The actions POST takes, as its refusal names them. */
const SUPPORT_ACTIONS = [
  "enable",
  "rotate",
  "rotate_inbound",
  "set_reply_hours",
  "set_notify",
  "propose_knowledge",
  "propose_custom",
  "publish",
  "retire",
  "resolve_ticket",
  "erase_conversation",
  "erase_ticket",
  "cluster_faq",
  "draft_reply",
  "save_reply",
  "approve_reply",
  "send_reply",
  "decline_reply",
] as const;

export async function POST(request: NextRequest): Promise<NextResponse> {
  // Review 2026-10-23 (#24): every action here is the owner's, from the
  // owner's own screen, so a POST that can't show it came from our origin is
  // refused before anything is read — SameSite=Lax alone was the only CSRF
  // guard. The widget's public route (/api/support/public) is a separate
  // file and stays cross-origin.
  const { tr, locale } = await requestTr(SUPPORT_WORDS);
  if (!isSameOriginPost(request.headers, appOriginOf(request.url))) {
    console.warn(JSON.stringify({ event: "support_cross_site_refused", account_id: null }));
    return NextResponse.json({ error: tr("error.crossSite") }, { status: 403 });
  }
  const profileId = await resolveProfile();
  if (!profileId) return NextResponse.json({ error: "no intake session" }, { status: 401 });
  const session = await matchingSession();
  if (!session) {
    return NextResponse.json({ error: tr("error.signIn") }, { status: 401 });
  }
  const required = (field: string) =>
    NextResponse.json({ error: tr("error.required", { field }) }, { status: 422 });
  const requiredBoth = (first: string, second: string) =>
    NextResponse.json({ error: tr("error.requiredBoth", { first, second }) }, { status: 422 });
  try {
    const body = (await request.json()) as {
      action?: unknown;
      proposal_id?: unknown;
      entry_id?: unknown;
      ticket_id?: unknown;
      reply_id?: unknown;
      hours?: unknown;
      on?: unknown;
      body?: unknown;
      status?: unknown;
      answer?: unknown;
      question?: unknown;
      conversation_id?: unknown;
    };
    const denied = requireRole(session, SUPPORT_ROLE[String(body.action)] ?? "support.settings");
    if (denied) return denied;
    switch (body.action) {
      case "enable": {
        const settings = await ensureSupportSettings(profileId);
        return NextResponse.json({ site_key: settings.site_key }, { status: 201 });
      }
      case "rotate": {
        const settings = await rotateSiteKey(profileId);
        return NextResponse.json({ site_key: settings.site_key });
      }
      case "set_reply_hours": {
        // P4-11: the owner's own stated reply time, or null for none.
        const hours = body.hours === null ? null : Number(body.hours);
        if (hours !== null && !Number.isFinite(hours)) {
          return NextResponse.json({ error: tr("error.hours") }, { status: 422 });
        }
        const settings = await setReplyHours(profileId, hours);
        return NextResponse.json({ reply_hours: settings.reply_hours });
      }
      case "set_notify": {
        const settings = await setNotifyOwner(profileId, body.on === true);
        return NextResponse.json({ notify_owner: settings.notify_owner });
      }
      case "rotate_inbound": {
        await rotateInboundToken(profileId);
        return NextResponse.json({ rotated: true });
      }
      case "erase_ticket": {
        // GDPR erasure of one ticket and its emails (rule 22). Irreversible, so signed-in only.
        if (typeof body.ticket_id !== "string") {
          return required("ticket_id");
        }
        await eraseTicket(session.account_id, body.ticket_id);
        return NextResponse.json({ erased: true });
      }
      case "propose_knowledge": {
        const proposal = await proposeKnowledgeEntries(profileId);
        return NextResponse.json({ proposal_id: proposal.id, status: proposal.status });
      }
      case "propose_custom": {
        if (typeof body.question !== "string" || typeof body.answer !== "string") {
          return requiredBoth("question", "answer");
        }
        const proposal = await proposeCustomKnowledge(profileId, {
          question: body.question,
          answer: body.answer,
        });
        return NextResponse.json({ proposal_id: proposal.id, status: proposal.status });
      }
      case "publish": {
        if (typeof body.proposal_id !== "string") {
          return required("proposal_id");
        }
        const entries = await publishKnowledgeFromProposal(body.proposal_id, {
          expectedProfileId: profileId,
        });
        return NextResponse.json({ published: entries.length });
      }
      case "retire": {
        if (typeof body.entry_id !== "string") {
          return required("entry_id");
        }
        const entry = await retireKnowledgeEntry(profileId, body.entry_id);
        return NextResponse.json({ status: entry.status });
      }
      case "resolve_ticket": {
        if (typeof body.ticket_id !== "string") {
          return required("ticket_id");
        }
        const status = body.status === "closed" ? "closed" : "answered";
        const ticket = await resolveTicket(
          profileId,
          body.ticket_id,
          status,
          typeof body.answer === "string" ? body.answer : undefined,
        );
        return NextResponse.json({ status: ticket.status, answered: ticket.answer !== null });
      }
      case "erase_conversation": {
        // GDPR erasure of one widget conversation (rule 22), for a visitor
        // who never became a contact. Irreversible, so signed-in only.
        if (typeof body.conversation_id !== "string") {
          return required("conversation_id");
        }
        await eraseConversation(session.account_id, body.conversation_id);
        return NextResponse.json({ erased: true });
      }
      case "draft_reply": {
        // The owner's click — the only way a model drafts a reply (P4-10).
        if (typeof body.ticket_id !== "string") {
          return required("ticket_id");
        }
        const outcome = await draftReply({ profileId, ticketId: body.ticket_id });
        return NextResponse.json(
          outcome.drafted
            ? { drafted: true, reply_id: outcome.reply.id }
            : { drafted: false, message: draftRefusalWords(outcome.message, tr, locale) },
        );
      }
      case "save_reply": {
        if (typeof body.ticket_id !== "string" || typeof body.body !== "string") {
          return requiredBoth("ticket_id", "body");
        }
        const reply = await saveReplyText(profileId, body.ticket_id, body.body);
        return NextResponse.json({ reply_id: reply.id, status: reply.status });
      }
      case "decline_reply": {
        if (typeof body.reply_id !== "string") {
          return required("reply_id");
        }
        const reply = await declineReply({
          profileId,
          replyId: body.reply_id,
          userId: session.user_id,
        });
        return NextResponse.json({ status: reply.status });
      }
      case "approve_reply":
      case "send_reply": {
        // Approve the exact words on screen and send them — or, for a reply
        // approved earlier and not yet sent (no key then, or the stop), send it.
        if (typeof body.reply_id !== "string") {
          return required("reply_id");
        }
        if (body.action === "approve_reply") {
          if (typeof body.body !== "string") {
            return required("body");
          }
          await approveReply({
            profileId,
            replyId: body.reply_id,
            userId: session.user_id,
            body: body.body,
          });
        }
        const sent = await sendApprovedReply({ profileId, replyId: body.reply_id });
        return NextResponse.json({ ...sent, note: outcomeNoteWords(sent.note, tr, locale) });
      }
      case "cluster_faq": {
        const outcome = await clusterQuestions(profileId, session.account_id);
        return NextResponse.json(outcome);
      }
      default:
        return NextResponse.json(
          { error: tr("error.action", { actions: orList(SUPPORT_ACTIONS, locale) }) },
          { status: 422 },
        );
    }
  } catch (error) {
    return onError(error, tr, locale);
  }
}
