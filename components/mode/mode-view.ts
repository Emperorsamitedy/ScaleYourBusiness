// How I work — the words and dates the mode screen prints, pure so they
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
  } | null;
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

/** The screen's one line. */
export function headline(d: ModeDecision, tr: Tr = EN()): string {
  if (d.mode === "watching" && d.watch_weeks !== null) {
    return tr("headline.watching", { days: d.watch_weeks * 7 });
  }
  return tr("headline.instant");
}

/** Day N of M of the watch — the same arithmetic as the menu's count. */
export function watchDay(d: ModeDecision, now: number): { day: number; of: number } | null {
  if (d.mode !== "watching" || d.watch_weeks === null) return null;
  const of = d.watch_weeks * 7;
  const left = Math.max(0, Math.ceil((parseTs(d.review_at) - now) / DAY_MS));
  return { day: Math.min(of, Math.max(1, of - left)), of };
}

/** "Chosen 29 Sep", plus the override when one is on record. */
export function chosenLine(d: ModeDecision, tr: Tr = EN(), locale: AppLocale = "en"): string {
  const chosen = tr("chosen", { date: dayMonth(parseTs(d.decided_at), locale) });
  const o = d.owner_override;
  if (!o) return chosen;
  return tr("chosenOverride", {
    chosen,
    kind: o.kind,
    weeks: o.to_weeks,
    date: dayMonth(parseTs(o.at), locale),
  });
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
