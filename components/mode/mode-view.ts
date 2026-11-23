// How Lex works (was How I work) — the words and dates the mode screen prints, pure so they
// are tested (the owner's How-I-work design, 2026-10-17). Everything is
// read off the stored decision: the mode, the CURRENT watch length (an
// override can have changed it since the decision), when it was decided,
// when the watch ends, and any override on record.
//
// L-3c (TASKS-LANGUAGES.md): the words are the "mode" catalogue through an
// optional translator, English by default from messages/en.json, so English
// says exactly what it always said; dates in the reader's locale. The
// stored reasons and reasoning are the rule's own record (L-4), shown as
// they are.

import { dayMonth as intlDayMonth } from "../../lib/i18n/format";
import type { AppLocale } from "../../lib/i18n/locales";
import type { Tr } from "../../lib/i18n/tr";
import { englishTr } from "../../lib/i18n/tr";
import type { ModeDecisionInputs } from "../../lib/mode/decide";

const EN = (): Tr => englishTr("mode");

export interface ModeDecision {
  mode: "instant" | "watching";
  watch_weeks: number | null;
  decided_at: string;
  reasons: string[];
  reasoning: string;
  review_at: string;
  owner_override?: {
    kind: "extend" | "shorten";
    from_weeks: number;
    to_weeks: number;
    at: string;
    /** The owner's own words when they changed it (P1-44), when on record. */
    acknowledgement?: { text: string; at: string } | null;
  } | null;
  /** The rule's named inputs, stored with the decision: the reasons are said from these. */
  inputs?: Partial<ModeDecisionInputs> | null;
}

const DAY_MS = 86_400_000;

/** Postgres prints "2026-10-17 15:20:35.26+00"; make it ISO before parsing. */
export function parseTs(s: string): number {
  const iso = s
    .trim()
    .replace(" ", "T")
    .replace(/([+-]\d\d)$/, "$1:00");
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? Date.parse(s) : ms;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * "29 Sep" — fixed three-letter months in English, whatever the runtime's
 * locale data says; the reader's own short form in any other language.
 * The day is the browser's local one, as before.
 */
export const dayMonth = (ms: number, locale: AppLocale = "en"): string => {
  const d = new Date(ms);
  if (locale !== "en") {
    return intlDayMonth(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, locale);
  }
  return `${d.getDate()} ${MONTHS[d.getMonth()] ?? ""}`;
};

/** The screen's one line (2026-11-23, said plainly): how Lex starts here. */
export function title(d: ModeDecision, tr: Tr = EN()): string {
  if (d.mode === "watching" && d.watch_weeks !== null) {
    return tr("title.watching", { count: d.watch_weeks });
  }
  return tr("title.instant");
}

/** Day N of M of the watch — the same arithmetic as the menu's count. */
export function watchDay(d: ModeDecision, now: number): { day: number; of: number } | null {
  if (d.mode !== "watching" || d.watch_weeks === null) return null;
  const of = d.watch_weeks * 7;
  const left = Math.max(0, Math.ceil((parseTs(d.review_at) - now) / DAY_MS));
  return { day: Math.min(of, Math.max(1, of - left)), of };
}

/** "Lex suggested 8 weeks; you chose 4." when the owner changed the length; null otherwise. */
export function overrideLine(d: ModeDecision, tr: Tr = EN()): string | null {
  const o = d.owner_override;
  if (!o) return null;
  return tr("override", { kind: o.kind, from: o.from_weeks, to: o.to_weeks });
}

/** One reason, as a message key under "reason" and its values. */
export interface PlainReason {
  key: string;
  values?: Record<string, number>;
}

/**
 * Pure: why the rule chose what it did, each said once, from the inputs it
 * stored (lib/mode/decide): the same conditions, in the same order, worded
 * for an owner. Null when the decision carries no inputs, so the caller
 * shows the stored reasons instead.
 */
export function plainReasons(d: ModeDecision): PlainReason[] | null {
  const i = d.inputs;
  if (!i) return null;
  const out: PlainReason[] = [];
  const orders = i.monthly_order_count ?? null;
  const months = i.months_operating ?? null;
  if (d.mode === "watching") {
    if (i.has_revenue && (orders ?? 10) >= 10) {
      out.push(orders !== null ? { key: "orders", values: { count: orders } } : { key: "revenue" });
    }
    if ((i.employee_count ?? 0) > 0)
      out.push({ key: "staff", values: { count: i.employee_count ?? 0 } });
    if (i.has_active_ad_spend) out.push({ key: "ads" });
    if (i.has_customer_support_process) out.push({ key: "support" });
    if (months !== null && months >= 3) out.push(trading(months));
    if (d.reasons.includes("The figures given are mostly estimates"))
      out.push({ key: "estimates" });
    return out;
  }
  out.push({ key: i.has_revenue ? "fewOrders" : "noRevenue" });
  out.push({ key: "noStaff" });
  out.push({ key: "noAds" });
  out.push({ key: months === null ? "notTrading" : "new" });
  return out;
}

/** "Trading for 5 months", "over a year", "over 5 years": a whole number of years once it is one. */
function trading(months: number): PlainReason {
  if (months < 12) return { key: "tradingMonths", values: { count: months } };
  const years = Math.floor(months / 12);
  return months % 12 === 0
    ? { key: "tradingYears", values: { count: years } }
    : { key: "tradingOver", values: { count: years } };
}

/**
 * Months read as years once they stop being months-sized. The reasons are
 * the rule's stored English (L-4 words them per language); this only
 * rewrites English's own month counts.
 */
export const humanise = (reason: string): string =>
  reason.replace(/(\d+) months/g, (m, n: string) => {
    const months = Number(n);
    if (months < 24) return m;
    return `${Math.round(months / 12)} years`;
  });
