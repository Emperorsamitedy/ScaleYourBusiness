// Pure read-model for a campaign's send on /customers — P4-15.
//
// The owner reads, per campaign: where it stands in one sentence, which
// gate is holding it (in words, first in the engine's order), the counts —
// sent, refused by reason, outcome unknown, failed, still to send,
// unsubscribed since — and, plainly, that a sent email can't be recalled.
// Counted from the API's figures; nothing is estimated.
//
// L-3c (TASKS-LANGUAGES.md): the fixed words are the "customers.campaign"
// catalogue through an optional translator, English by default from
// messages/en.json, so English says exactly what it always said; counts,
// rates and dates in the reader's locale. L-4c: measuredSentence is the
// "customersWords" catalogue; the gate words and the arithmetic arrive from
// the server already in the reader's language (lib/crm/localize).

import { dayMonthYear } from "../../lib/i18n/format";
import type { AppLocale } from "../../lib/i18n/locales";
import { intlTag } from "../../lib/i18n/locales";
import type { Tr } from "../../lib/i18n/tr";
import { englishTr } from "../../lib/i18n/tr";
import { num } from "../sheet/num";

const EN = (): Tr => englishTr("customers.campaign");

export type SendPhase = "awaiting_draft" | "awaiting_approval" | "held" | "sending" | "sent";

export interface SendCounts {
  pending: number;
  refused: number;
  sending: number;
  sent: number;
  failed: number;
  unknown: number;
  unsubscribed: number;
  total: number;
  refused_by_reason: Record<string, number>;
}

export interface SendView {
  phase: SendPhase;
  gates: { code: string; words: string }[];
  counts: SendCounts;
  approved_at: string | null;
  subject: string | null;
  body_sha256: string | null;
  execution: {
    status: string;
    held_for: string | null;
    error: string | null;
    finished_at: string | null;
  } | null;
}

/** The owner's words for each refusal code — never an address, never a name. */
export const REFUSAL_WORDS: Readonly<Record<string, string>> = {
  consent_implied: "consent only implied",
  consent_unsure: "consent unsure",
  consent_none: "no consent",
  suppressed: "unsubscribed, marked as spam, or erased",
  consent_unproven: "consent not recorded with how and when",
  no_regime: "in a country I have no email rules for",
  message_incomplete: "the email lacked something their law requires",
  no_email: "no email address",
  contact_gone: "no longer in your customers",
  duplicate_address: "same address as another recipient",
};

/** Pure: the phase as a worded flag; cobalt only while the machine is genuinely sending. */
export function phaseFlag(
  phase: SendPhase,
  tr: Tr = EN(),
): {
  word: string;
  tone: "ok" | "low" | "drift" | "live";
} {
  switch (phase) {
    case "sent":
      return { word: tr("phase.sent"), tone: "ok" };
    case "sending":
      return { word: tr("phase.sending"), tone: "live" };
    case "held":
      return { word: tr("phase.held"), tone: "drift" };
    case "awaiting_approval":
      return { word: tr("phase.awaiting_approval"), tone: "low" };
    default:
      return { word: tr("phase.awaiting_draft"), tone: "low" };
  }
}

/** A day as the send line prints it: ISO in English (as it always was), the reader's date otherwise. */
function sentDay(iso: string, locale: AppLocale): string {
  return locale === "en" ? iso.slice(0, 10) : dayMonthYear(iso, locale);
}

/** Pure: where the send stands, in one first-person sentence. */
export function sendSentence(
  v: SendView,
  recipients: number,
  tr: Tr = EN(),
  locale: AppLocale = "en",
): string {
  switch (v.phase) {
    case "awaiting_draft":
      return tr("sentence.awaiting_draft");
    case "awaiting_approval":
      return tr("sentence.awaiting_approval", { count: recipients });
    case "held":
      // The gate's own words come from the server (L-4).
      return v.gates[0] ? tr("sentence.heldGate", { gate: v.gates[0].words }) : tr("sentence.held");
    case "sending":
      return tr("sentence.sending", {
        sent: num(v.counts.sent, 0, locale),
        total: num(v.counts.total, 0, locale),
      });
    case "sent":
      return v.execution?.finished_at
        ? tr("sentence.sentOn", {
            count: v.counts.sent,
            date: sentDay(v.execution.finished_at, locale),
          })
        : tr("sentence.sent", { count: v.counts.sent });
  }
}

/** The English refusal word's key in the catalogue, by refusal code. */
export function refusalWord(code: string, tr: Tr = EN()): string {
  return code in REFUSAL_WORDS ? tr(`refusal.${code}`) : code;
}

/** Pure: the counts table, in order, leaving out what is zero (except sent). */
export function countRows(c: SendCounts, tr: Tr = EN()): { label: string; n: number }[] {
  const rows: { label: string; n: number }[] = [
    { label: tr("count.sent"), n: c.sent },
    { label: tr("count.refused"), n: c.refused },
    { label: tr("count.unknown"), n: c.unknown + c.sending },
    { label: tr("count.failed"), n: c.failed },
    { label: tr("count.pending"), n: c.pending },
    { label: tr("count.unsubscribed"), n: c.unsubscribed },
  ];
  return rows.filter((r, i) => i === 0 || r.n > 0);
}

/** Pure: refused recipients by reason, most first, in words. */
export function refusalLines(c: SendCounts, tr: Tr = EN(), locale: AppLocale = "en"): string[] {
  return Object.entries(c.refused_by_reason)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([code, n]) => `${refusalWord(code, tr)} · ${num(n, 0, locale)}`);
}

/** Pure: the honest line about unconfirmed sends, or null. */
export function unknownLine(c: SendCounts, tr: Tr = EN()): string | null {
  const n = c.unknown + c.sending;
  if (n === 0) return null;
  return tr("unknown", { count: n });
}

/* ── P4-17: the readback, once a campaign has gone out ── */

export type ReadbackVerdict = "helped" | "did_nothing" | "backfired" | "too_early" | "unmeasured";

export interface ReadbackGroup {
  size: number;
  erased: number;
  measured: number;
  returned: number;
  waiting: number;
  measured_through: string | null;
}

export interface ReadbackView {
  verdict: ReadbackVerdict;
  kind: "winback" | "vip";
  lift_pp: number | null;
  controlled: boolean;
  arithmetic: string;
  sent_on: string | null;
  delivery: {
    sent: number;
    unknown: number;
    delivered: number;
    bounced: number;
    complained: number;
    unsubscribed: number;
    harmed: number;
  };
  recipients: ReadbackGroup;
  comparison: ReadbackGroup;
  /** Whether the email service's delivery webhook is set up at all. */
  delivery_reported: boolean;
  /** Where replies go: the owner's own address, named in their consent. */
  replies_to: string | null;
}

/** Pure: the verdict as a worded flag — the same words as the history ledger. */
export function readbackFlag(
  v: ReadbackVerdict,
  tr: Tr = EN(),
): { word: string; tone: "ok" | "low" | "alarm" } {
  switch (v) {
    case "helped":
      return { word: tr("verdict.helped"), tone: "ok" };
    case "backfired":
      return { word: tr("verdict.backfired"), tone: "alarm" };
    case "did_nothing":
      return { word: tr("verdict.did_nothing"), tone: "low" };
    case "too_early":
      return { word: tr("verdict.too_early"), tone: "low" };
    default:
      return { word: tr("verdict.unmeasured"), tone: "low" };
  }
}

/** A share to one decimal: "40.0%" in English, the language's own percent otherwise. */
function rate(n: number, d: number, locale: AppLocale = "en"): string {
  if (d === 0) return "—";
  if (locale === "en") return `${((n / d) * 100).toFixed(1)}%`;
  return new Intl.NumberFormat(intlTag(locale), {
    style: "percent",
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(Number(((n / d) * 100).toFixed(1)) / 100);
}

/** Pure: the readback table — label, count with its unit, and the rate it is a share of. */
export function readbackRows(
  r: ReadbackView,
  tr: Tr = EN(),
  locale: AppLocale = "en",
): { label: string; count: string; rate: string }[] {
  const d = r.delivery;
  const emails = (n: number) => tr("readback.emails", { count: n });
  const people = (n: number) => tr("readback.people", { count: n });
  const pc = (n: number, of: number) => rate(n, of, locale);
  const reported = (n: number, unit: (n: number) => string) =>
    r.delivery_reported
      ? { count: unit(n), rate: pc(n, d.sent) }
      : { count: tr("readback.notReported"), rate: "—" };
  const measuredOf = (g: ReadbackGroup) =>
    tr("readback.measuredOf", {
      returned: num(g.returned, 0, locale),
      measured: num(g.measured, 0, locale),
    });
  const rows = [
    { label: tr("readback.row.sent"), count: emails(d.sent), rate: "" },
    { label: tr("readback.row.delivered"), ...reported(d.delivered, emails) },
    { label: tr("readback.row.bounced"), ...reported(d.bounced, emails) },
    {
      label: tr("readback.row.unsubscribed"),
      count: people(d.unsubscribed),
      rate: pc(d.unsubscribed, d.sent),
    },
    { label: tr("readback.row.spam"), ...reported(d.complained, people) },
    { label: tr("readback.row.replied"), count: tr("readback.notCounted"), rate: "—" },
    {
      label: tr("readback.row.boughtAgain"),
      count: measuredOf(r.recipients),
      rate: pc(r.recipients.returned, r.recipients.measured),
    },
    {
      label: tr("readback.row.comparison", { group: r.kind === "vip" ? "vip" : "winback" }),
      count: measuredOf(r.comparison),
      rate: pc(r.comparison.returned, r.comparison.measured),
    },
  ];
  if (r.lift_pp !== null) {
    rows.push({
      label: tr("readback.row.difference"),
      count: tr("readback.points", {
        value: `${r.lift_pp >= 0 ? "+" : "−"}${num(Math.abs(r.lift_pp), 1, locale)}`,
      }),
      rate: "",
    });
  }
  return rows;
}

/** "a, b and c" (or "or") as this sentence always joined it in English; the language's own list otherwise. */
function joined(items: string[], word: "and" | "or", locale: AppLocale): string {
  if (locale !== "en") {
    return new Intl.ListFormat(intlTag(locale), { type: "conjunction" }).format(items);
  }
  const last = items[items.length - 1] ?? "";
  return items.length > 1 ? `${items.slice(0, -1).join(", ")} ${word} ${last}` : last;
}

/**
 * Pure: one first-person sentence on what was measured and what wasn't.
 * L-4c: the "customersWords" catalogue, English by default (its old words exactly).
 */
export function measuredSentence(
  r: ReadbackView,
  tr: Tr = englishTr("customersWords"),
  locale: AppLocale = "en",
): string {
  const through = r.recipients.measured_through ?? r.comparison.measured_through;
  const counted = [
    r.delivery_reported ? tr("measured.delivery") : null,
    tr("measured.unsubscribes"),
    through
      ? tr("measured.purchasesOf", { date: sentDay(through, locale) })
      : tr("measured.purchasesNext"),
  ].filter((x): x is string => x !== null);
  const notCounted = [
    r.delivery_reported ? null : tr("measured.notDelivery"),
    tr("measured.opens"),
    r.replies_to ? tr("measured.repliesAt", { address: r.replies_to }) : tr("measured.replies"),
  ].filter((x): x is string => x !== null);
  return tr(r.controlled ? "measured.sentenceControlled" : "measured.sentence", {
    counted: joined(counted, "and", locale),
    notCounted: joined(notCounted, "or", locale),
  });
}

/** Pure: the readback's arithmetic as a sentence ("….") — the period is the language's. */
export function arithmeticSentence(
  arithmetic: string,
  tr: Tr = englishTr("customersWords"),
): string {
  return tr("sentence", { text: arithmetic });
}
