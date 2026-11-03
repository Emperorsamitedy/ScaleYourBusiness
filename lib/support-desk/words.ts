// The support desk's owner-facing server sentences in the reader's language
// — L-4c of TASKS-LANGUAGES.md, namespace "supportWords". Presentation only
// (rules 3 and 4): a refusal keeps its English message for the logs and the
// tests, a reply's stored outcome note and a stored proposal summary keep
// their English rows; the screen is sent each said again with the request's
// translator — but only when SYB's own English reproduces it byte for byte
// (lib/crm/say.ts). Anything else is shown as it came: another module's
// words (the proposal queue's), the email service's own message, the
// owner's question inside a summary.
//
// Owner-facing only. What a customer reads — the widget, the AI disclosure,
// a drafted reply — speaks the business's language and is L-5/L-6.

import { intlMoney } from "../i18n/format";
import type { AppLocale } from "../i18n/locales";
import type { Tr } from "../i18n/tr";
import { englishTr } from "../i18n/tr";
import { sayer } from "../crm/say";

/** The namespace of the desk's server-built sentences. */
export const SUPPORT_WORDS = "supportWords";

/** English, from messages/en.json — what the code always said. */
export const supportEnglish = (): Tr => englishTr(SUPPORT_WORDS);

/** The refusals lib/crm (knowledge, settings, faq, erasure), lib/support and lib/support-desk throw. */
export const ERROR_KEYS = [
  "error.nothingNew",
  "error.bothRequired",
  "error.tooLong",
  "error.noProposal",
  "error.notKnowledge",
  "error.notApproved",
  "error.noEntries",
  "error.noEntry",
  "error.noProfile",
  "error.replyHours",
  "error.noConversation",
  "error.noTicket",
  "error.answerLong",
  "error.noOpenTicket",
  "error.notRecorded",
  "error.faqDeclined",
  "error.noReply",
  "error.liveReply",
  "error.noAddressDraft",
  "error.notEnabled",
  "error.writeFirst",
  "error.replyLong",
  "error.already",
  "error.changedEditing",
  "error.noAddress",
  "error.notSaved",
  "error.draftNotSaved",
  "error.decided",
] as const;

/** Why a reply wasn't drafted (lib/support-desk/draft). */
export const DRAFT_KEYS = [
  "draft.cant",
  "draft.budget",
  "draft.times",
  "draft.unreachable",
] as const;

/** A send's outcome note (lib/support-desk/replies), stored on the reply. "suppressed" before "refused". */
export const NOTE_KEYS = [
  "note.notSetUp",
  "note.stopped",
  "note.maybeSent",
  "note.noAddress",
  "note.suppressed",
  "note.refused",
  "note.notEnabled",
  "note.textChanged",
  "note.serviceRefused",
] as const;

/** A knowledge proposal's summary (lib/crm/knowledge, lib/crm/faq), stored on the proposal. */
export const SUMMARY_KEYS = [
  "summary.facts",
  "summary.custom",
  "summary.faq",
  "summary.fallback",
] as const;

/** "€5" as the draft refusal writes SYB's own budget: the language's own money, still EUR. */
function budget(name: string, value: string, _tr: Tr, locale: AppLocale): string | undefined {
  if (name !== "budget") return undefined;
  const m = /^€(\d+(?:\.\d+)?)$/.exec(value);
  if (!m) return value;
  const n = Number(m[1]);
  return intlMoney(n, "EUR", Number.isInteger(n) ? 0 : 2, locale);
}

const errors = sayer(SUPPORT_WORDS, [...ERROR_KEYS, ...DRAFT_KEYS]);
const drafts = sayer(SUPPORT_WORDS, DRAFT_KEYS, { format: budget });
const notes = sayer(SUPPORT_WORDS, NOTE_KEYS);
const summaries = sayer(SUPPORT_WORDS, SUMMARY_KEYS);

/** A refusal thrown in lib/ (error.message), in the reader's language; another module's as it came. */
export function supportErrorWords(message: string, tr: Tr, locale: AppLocale): string {
  return errors.say(message, tr, locale);
}

/** Why a reply wasn't drafted, in the reader's language. */
export function draftRefusalWords(message: string, tr: Tr, locale: AppLocale): string {
  return drafts.say(message, tr, locale);
}

/** A reply's outcome note (stored, or just returned by a send), in the reader's language. */
export function outcomeNoteWords(note: string | null, tr: Tr, locale: AppLocale): string | null {
  return note === null ? null : notes.say(note, tr, locale);
}

/** A knowledge proposal's stored summary, in the reader's language when it is SYB's own. */
export function knowledgeSummaryWords(summary: string, tr: Tr, locale: AppLocale): string {
  return summaries.say(summary, tr, locale);
}
