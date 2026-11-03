// Pure read-model for the owner's support screen (the instrument design,
// 2026-10-17): the headline, the counts line, and how each conversation
// is worded in the list. Counted from what the API returns; nothing here
// reads a customer's message as anything but text (rule 24).
//
// L-3c (TASKS-LANGUAGES.md): the words are the "support" catalogue through
// an optional translator, English by default from messages/en.json, so
// English says exactly what it always said; times, dates and figures in
// the reader's locale. A customer's words are content, shown as written.

import type { AppLocale } from "../../lib/i18n/locales";
import { intlTag } from "../../lib/i18n/locales";
import type { Tr } from "../../lib/i18n/tr";
import { englishTr } from "../../lib/i18n/tr";
import type { SlaState } from "../../lib/support/sla";
import { slaState } from "../../lib/support/sla";
import { num } from "../sheet/num";

const EN = (): Tr => englishTr("support");

export type TicketReason =
  "customer_asked" | "no_answer" | "cost_cap" | "conversation_cap" | "emailed";
export type TicketStatus = "open" | "answered" | "closed";
export type ConversationStatus = "open" | "escalated" | "closed";

/** How much of an email is kept: SUPPORT_EMAIL_BODY_MAX_CHARS (lib/support/inbound), held equal by words.test.ts. */
export const EMAIL_KEPT_CHARS = 20_000;

export const TICKET_REASONS: readonly TicketReason[] = [
  "customer_asked",
  "no_answer",
  "cost_cap",
  "conversation_cap",
  "emailed",
];

/** Why a conversation was handed to the owner: "asked for a person". */
export function reasonWord(reason: TicketReason, tr: Tr = EN()): string {
  return tr(`reason.${reason}`);
}

export function supportHeadline(publicAnswers: number, tr: Tr = EN()): string {
  return publicAnswers === 0 ? tr("headline.none") : tr("headline.some");
}

/** "Nobody waiting for you", "One waiting for you" … "12 waiting for you". */
export function waitingTitle(waiting: number, tr: Tr = EN()): string {
  return tr("waitingTitle", { count: waiting });
}

/**
 * The server's two fixed notes on an unproven sender (SENDER_NOT_VERIFIED
 * and GIVEN_IN_CHAT in lib/support/email-tickets, held equal by
 * words.test.ts), worded in the reader's language; anything else as sent.
 */
export function senderNoteWord(note: string, tr: Tr = EN()): string {
  if (note === "sender not verified") return tr("senderNote.notVerified");
  if (note === "given in chat, not verified") return tr("senderNote.givenInChat");
  return note;
}

/** The state line under a conversation in the list, and its tone. */
export function conversationWord(
  status: ConversationStatus,
  ticket: { status: TicketStatus; reason: TicketReason } | null,
  tr: Tr = EN(),
): { word: string; tone: "drift" | "ok" | "low" } {
  if (ticket?.status === "open") return { word: tr("conv.waiting"), tone: "drift" };
  if (ticket?.status === "answered") return { word: tr("conv.answered"), tone: "ok" };
  if (ticket?.status === "closed") return { word: tr("conv.handedClosed"), tone: "low" };
  if (status === "escalated") return { word: tr("conv.handed"), tone: "drift" };
  if (status === "closed") return { word: tr("conv.closed"), tone: "low" };
  return { word: tr("conv.open"), tone: "low" };
}

/** "13:52" today, "Fri" this week, "12 Oct" before that — in the reader's language. */
export function whenShort(iso: string, now: Date = new Date(), locale: AppLocale = "en"): string {
  const d = new Date(iso);
  const tag = intlTag(locale);
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString(tag, { hour: "2-digit", minute: "2-digit" });
  }
  if (now.getTime() - d.getTime() < 6 * 86_400_000 && d.getTime() <= now.getTime()) {
    return d.toLocaleDateString(tag, { weekday: "short" });
  }
  return d.toLocaleDateString(tag, { day: "numeric", month: "short" });
}

/** "02 Oct": a knowledge entry's publication day, in the reader's language. */
export function dayWord(iso: string, locale: AppLocale = "en"): string {
  return new Date(iso).toLocaleDateString(intlTag(locale), { day: "2-digit", month: "short" });
}

/** "17 Oct, 13:52": when a thread was last active, in the reader's language. */
export function whenFull(iso: string, locale: AppLocale = "en"): string {
  return new Date(iso).toLocaleString(intlTag(locale), {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * "45 min", "3 h 20 min", "2 d 4 h" — figures with units, rounded down to
 * the minute. English is lib/support/sla durationText exactly (words.test.ts).
 */
export function durationWords(ms: number, tr: Tr = EN(), locale: AppLocale = "en"): string {
  const n = (v: number) => num(v, 0, locale);
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 60) return tr("duration.min", { min: n(minutes) });
  const hours = Math.floor(minutes / 60);
  if (hours < 48) {
    const rest = minutes % 60;
    return rest === 0
      ? tr("duration.h", { h: n(hours) })
      : tr("duration.hMin", { h: n(hours), min: n(rest) });
  }
  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  return rest === 0
    ? tr("duration.d", { d: n(days) })
    : tr("duration.dH", { d: n(days), h: n(rest) });
}

/**
 * The worded flag and its figure, as the ticket list prints them. English
 * is lib/support/sla slaWords exactly (words.test.ts).
 */
export function slaFlagWords(
  state: SlaState,
  tr: Tr = EN(),
  locale: AppLocale = "en",
): { flag: string; detail: string } {
  switch (state.flag) {
    case "unset":
      return { flag: tr("sla.unset"), detail: "" };
    case "overdue":
      return {
        flag: tr("sla.overdue"),
        detail: tr("sla.over", { duration: durationWords(state.over_ms ?? 0, tr, locale) }),
      };
    case "due_soon":
      return {
        flag: tr("sla.dueSoon"),
        detail: tr("sla.left", { duration: durationWords(state.left_ms ?? 0, tr, locale) }),
      };
    case "in_time":
      return {
        flag: tr("sla.inTime"),
        detail: tr("sla.left", { duration: durationWords(state.left_ms ?? 0, tr, locale) }),
      };
  }
}

export type ReplyStatus = "drafted" | "declined" | "approved" | "sending" | "sent" | "failed";

/** A reply's send state in words (P4-10). "sending" means the outcome is unknown, never "in progress". */
export function replyStateWord(
  status: ReplyStatus,
  tr: Tr = EN(),
): {
  word: string;
  tone: "drift" | "ok" | "low" | "alarm";
} {
  switch (status) {
    case "drafted":
      return { word: tr("replyState.drafted"), tone: "drift" };
    case "approved":
      return { word: tr("replyState.approved"), tone: "drift" };
    case "sending":
      return { word: tr("replyState.sending"), tone: "alarm" };
    case "sent":
      return { word: tr("replyState.sent"), tone: "ok" };
    case "failed":
      return { word: tr("replyState.failed"), tone: "alarm" };
    case "declined":
      return { word: tr("replyState.declined"), tone: "low" };
  }
}

/* ── P4-11: the ticket list, in words ── */

export interface TicketForList {
  channel: "chat" | "email";
  status: TicketStatus;
  from: string | null;
  has_address: boolean;
  summary: string;
  waiting_since: string | null;
}

export interface TicketLine {
  channel: string;
  who: string;
  what: string;
  /** How long they have waited, figures with units — empty when nobody is waiting. */
  waited: string;
  flag: string;
  detail: string;
  tone: "ok" | "drift" | "alarm" | "low";
}

const SLA_TONE = { in_time: "ok", due_soon: "drift", overdue: "alarm", unset: "low" } as const;

/** One row of the ticket list. Pure: the clock and the owner's reply time come in. */
export function ticketLine(
  t: TicketForList,
  now: Date,
  replyHours: number | null,
  tr: Tr = EN(),
  locale: AppLocale = "en",
): TicketLine {
  const base = {
    channel: t.channel === "email" ? tr("channel.email") : tr("channel.chat"),
    who: t.from ?? (t.has_address ? tr("who.customer") : tr("who.noAddress")),
    what: t.summary,
  };
  if (t.status !== "open") {
    return {
      ...base,
      waited: "",
      flag: t.status === "answered" ? tr("ticket.answeredFlag") : tr("ticket.closedFlag"),
      detail: "",
      tone: "low",
    };
  }
  if (t.waiting_since === null) {
    return {
      ...base,
      waited: "",
      flag: tr("ticket.youReplied"),
      detail: tr("ticket.theirTurn"),
      tone: "ok",
    };
  }
  const state = slaState(t.waiting_since, now, replyHours);
  const words = slaFlagWords(state, tr, locale);
  return {
    ...base,
    waited: durationWords(state.waited_ms, tr, locale),
    flag: words.flag,
    detail: words.detail,
    tone: SLA_TONE[state.flag],
  };
}
