// The customers API's sentences in the reader's language — L-4c of
// TASKS-LANGUAGES.md. Presentation only (rules 3 and 4): a stored proposal
// keeps the English it was written with, and a refusal keeps its English
// message for the logs and the tests; what goes to the screen is said again
// with the request's translator (lib/i18n/request-tr.ts).
//
// A stored sentence is said again only when SYB's own English reproduces it
// byte for byte (lib/crm/say.ts) — a campaign's summary and label from the
// proposal's own segment and recipients, a gate or a refusal from the
// catalogue's English. Anything else is shown as it came: another module's
// words (the execution engine's, the proposal queue's), an older wording.
// English readers get exactly what the API always sent.

import type { AppLocale } from "../i18n/locales";
import type { Tr } from "../i18n/tr";
import { dayMonth } from "../i18n/format";
import { watchingUntil } from "../care/watch-words";
import type { Gate } from "./campaign-send";
import type { CampaignSummaryKind } from "./segment-proposals";
import { campaignSummary } from "./segment-proposals";
import { sayer } from "./say";
import { CUSTOMERS_WORDS, customersEnglish } from "./words";

const EN = customersEnglish();

/** Every gate a campaign can be held by, by its code — GATE_WORDS and the reviews' and engine's words. */
export const GATE_KEYS = [
  "gate.stopped",
  "gate.no_mode_decision",
  "gate.watching",
  "gate.labelled_undoable",
  "gate.not_connected",
  "gate.outbound_off",
  "gate.email_not_set_up",
  "gate.no_draft",
  "gate.draft_not_approved",
  "gate.draft_changed",
  "gate.draft_incomplete",
  "gate.law_review_missing",
  "gate.law_review_stale",
  "gate.first_campaign_unreviewed",
  "gate.real_sends_off",
] as const;

/** The refusals lib/crm throws, worded in the catalogue. */
export const ERROR_KEYS = [
  "error.noFields",
  "error.provenance",
  "error.suppressed",
  "error.duplicate",
  "error.noContact",
  "error.noConversation",
  "error.noTicket",
  "error.attestation",
  "error.tooLarge",
  "error.noRows",
  "error.maxRows",
  "error.noColumns",
  "error.currency",
  "error.noProposal",
  "error.notEmail",
  "error.draftNotApproved",
  "error.notStored",
  "error.noProfile",
  "error.noCampaign",
  "error.sendNotApproved",
  "error.subject",
  "error.changed",
] as const;

/** A skipped segment's reasons (lib/crm/segment-proposals), worded in the catalogue. */
export const SKIP_KEYS = [
  "skip.posture",
  "skip.alreadyToday",
  "skip.alreadyMonth",
  "skip.cartRecent",
  "skip.noCart",
  "skip.nobody",
  "skip.noConsent",
  "skip.declined",
] as const;

/** What a send says when it ends or is held (lib/crm/campaign-send's sendCampaignNow). */
export const SEND_KEYS = ["send.sent", "send.unfinished", "send.reclaimed"] as const;

const labelValue = (name: string, value: string, tr: Tr) =>
  name === "label" && value === EN("gate.real_sends_label")
    ? tr("gate.real_sends_label")
    : undefined;

const gates = sayer(CUSTOMERS_WORDS, GATE_KEYS, { format: labelValue });
const errors = sayer(CUSTOMERS_WORDS, [...ERROR_KEYS, ...GATE_KEYS], { format: labelValue });
const skips = sayer(CUSTOMERS_WORDS, SKIP_KEYS);
const sends = sayer(CUSTOMERS_WORDS, [...SEND_KEYS, ...GATE_KEYS], { format: labelValue });

/** A gate holding a campaign, in the reader's language. */
export function gateWords(g: Gate, tr: Tr, locale: AppLocale): Gate {
  return { code: g.code, words: gates.say(g.words, tr, locale) };
}

/** A lib/crm refusal (error.message) in the reader's language; another module's as it came. */
export function crmErrorWords(message: string, tr: Tr, locale: AppLocale): string {
  return errors.say(message, tr, locale);
}

/** A send's outcome sentence: a gate's words with "Nothing was sent; this stays approved." after them. */
export function sendMessageWords(message: string, tr: Tr, locale: AppLocale): string {
  if (locale === "en") return message;
  const still = ` ${EN("send.stillApproved")}`;
  if (message.endsWith(still)) {
    const first = message.slice(0, -still.length);
    const said = sends.say(first, tr, locale);
    return said === first ? message : tr("join", { first: said, then: tr("send.stillApproved") });
  }
  return sends.say(message, tr, locale);
}

/** One skipped segment, with the line the screen shows ("lapsed: already proposed this month"). */
export interface SkipLine {
  segment: string;
  reason: string;
  line: string;
}

/**
 * The skipped segments of a propose run, each with its line in the reader's
 * language. `watchEndsAt` is the watch's end, read again, so the watch's
 * sentence is said with the reader's date.
 */
export function skipLines(
  skipped: readonly { segment: string; reason: string }[],
  watchEndsAt: string | null,
  tr: Tr,
  locale: AppLocale,
): SkipLine[] {
  return skipped.map((s) => {
    const english = `${s.segment}: ${s.reason}`;
    if (locale === "en") return { ...s, line: english };
    const reason =
      watchEndsAt !== null && s.reason === watchingUntil(watchEndsAt)
        ? tr("skip.watching", { date: dayMonth(watchEndsAt, locale) })
        : skips.say(s.reason, tr, locale);
    const segment = s.segment === "all" ? tr("segment.all") : segmentWord(s.segment, tr);
    return { ...s, line: tr("skip.line", { segment, reason }) };
  });
}

const SEGMENTS = ["lapsed", "lapsing", "new", "vip", "abandoned_cart"] as const;

function segmentWord(key: string, tr: Tr): string {
  return (SEGMENTS as readonly string[]).includes(key) ? tr(`segment.label.${key}`) : key;
}

const SUMMARY_KIND: Record<string, CampaignSummaryKind> = {
  lapsed: "winback",
  vip: "vip",
  abandoned_cart: "cart",
};

/**
 * A stored campaign proposal's summary and label in the reader's language,
 * said again from its segment and recipients when SYB's English for them is
 * exactly what is stored; as stored otherwise.
 */
export function campaignWords(
  stored: { summary: string; label: string | null },
  detail: { segment?: unknown; contact_ids?: unknown } | undefined,
  tr: Tr,
  locale: AppLocale,
): { summary: string; label: string | null } {
  if (locale === "en") return stored;
  const segment = typeof detail?.segment === "string" ? detail.segment : null;
  const kind = segment ? SUMMARY_KIND[segment] : undefined;
  const n = Array.isArray(detail?.contact_ids) ? detail.contact_ids.length : null;
  const summary =
    stored.summary === EN("campaign.fallback")
      ? tr("campaign.fallback")
      : kind && n !== null && campaignSummary(kind, n) === stored.summary
        ? campaignSummary(kind, n, tr, locale)
        : stored.summary;
  const label =
    stored.label !== null &&
    segment !== null &&
    (SEGMENTS as readonly string[]).includes(segment) &&
    EN(`segment.label.${segment}`) === stored.label
      ? tr(`segment.label.${segment}`)
      : stored.label;
  return { summary, label };
}
