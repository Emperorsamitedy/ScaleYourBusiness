// The watch's own words in the reader's language — L-4a of TASKS-LANGUAGES.md.
//
//   a signal's noun     lib/watch/watch-view SIGNAL_NOUN, by its metric key
//   "read from"         a connector's own name prints as it is; the bookings
//                       export (no connector) is named in the reader's words
//   the rules           lib/anomaly/thresholds' texts, read back
//   module explanations /api/modules' two "why" lines, read back
//   log lines           watch_activity.detail is stored as it happened (rule
//                       7's spirit: a log isn't rewritten). The kinds whose
//                       sentence SYB writes from numbers are read back
//                       through "watchWords.log", their figures, dates,
//                       weekdays and series names said again the reader's
//                       way; any other line prints as stored.
//
// The catalogue's English is word for word what the writers write
// (lib/watch/words.test.ts). Pure and safe in the browser.

import { intlMoney, intlNumber, dayMonthYear } from "../i18n/format";
import type { AppLocale } from "../i18n/locales";
import { intlTag } from "../i18n/locales";
import { englishPatterns, matchStored, plainValue, readStored } from "../i18n/stored";
import type { Tr } from "../i18n/tr";
import { englishTr } from "../i18n/tr";

export interface WatchWords {
  /** A translator over "watchWords". */
  tr: Tr;
  locale: AppLocale;
}

export const ENGLISH_WATCH: WatchWords = { tr: englishTr("watchWords"), locale: "en" };

const signalKey = (metric: string) => metric.replace(/\.daily$/, "");

/** Pure: a watched series' noun ("Revenue"), by its metric key; the English when unknown. */
export function signalNoun(metric: string, english: string, w: WatchWords = ENGLISH_WATCH): string {
  if (w.locale === "en") return english;
  const key = signalKey(metric);
  return englishOf("signal", key) === null ? english : w.tr(`signal.${key}`);
}

/** Pure: where a series is read from — a connector's name as it is, the bookings export in words. */
export function sourceWords(readFrom: string, w: WatchWords = ENGLISH_WATCH): string {
  if (w.locale === "en") return readFrom;
  const key = keyOfEnglish("source", readFrom);
  return key === null ? readFrom : w.tr(`source.${key}`);
}

/** Pure: an interruption rule's text in the reader's language. */
export function ruleWords(text: string, w: WatchWords = ENGLISH_WATCH): string {
  if (w.locale === "en") return text;
  return readStored(text, "watchWords.rule", (k, v) => w.tr(`rule.${k}`, v));
}

/** Pure: a module's explanation in the reader's language. */
export function moduleWords(text: string, w: WatchWords = ENGLISH_WATCH): string {
  if (w.locale === "en") return text;
  const key = keyOfEnglish("module", text);
  return key === null ? text : w.tr(`module.${key}`);
}

/** Pure: a watch-log line in the reader's language; as stored when it isn't one of SYB's sentences. */
export function logWords(text: string, w: WatchWords = ENGLISH_WATCH): string {
  if (w.locale === "en") return text;
  return readStored(
    text,
    "watchWords.log",
    (k, v) => w.tr(`log.${k}`, v),
    (name, raw) => logValue(name, raw, w),
    LOG_SHAPES,
  );
}

/**
 * A provider's name can have a space in it ("Google Analytics", "Meta Ads"),
 * so the sync line's data noun is held to the nouns lib/connectors/activity
 * writes, and the name takes the rest.
 */
const LOG_SHAPES = { data: "payments|orders|traffic|ad spend|data" } as const;

/* ── the catalogue's English, for reading stored words back ── */

const englishOf = (group: string, key: string): string | null => {
  const hit = englishPatterns(`watchWords.${group}`).find(([k]) => k === key);
  return hit ? hit[1] : null;
};

const keyOfEnglish = (group: string, english: string): string | null => {
  const hit = englishPatterns(`watchWords.${group}`).find(([, e]) => e === english);
  return hit ? hit[0] : null;
};

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function weekdayWord(english: string, locale: AppLocale): string {
  const i = WEEKDAYS.indexOf(english);
  if (i < 0) return english;
  // 2023-01-01 was a Sunday.
  return new Date(Date.UTC(2023, 0, 1 + i)).toLocaleDateString(intlTag(locale), {
    weekday: "long",
    timeZone: "UTC",
  });
}

/** "1 234.50 EUR" (lib/anomaly/detect formatValue) or "1 234" — the figure the reader's way. */
function figure(raw: string, locale: AppLocale): string {
  const money = /^(-?[\d ]+\.\d{2}) ([A-Z]{3})$/.exec(raw);
  if (money) return intlMoney(Number(money[1]!.replace(/ /g, "")), money[2]!, 2, locale);
  if (/^-?\d{1,3}( \d{3})*$/.test(raw)) return intlNumber(Number(raw.replace(/ /g, "")), 0, locale);
  return raw;
}

const decimals = (raw: string, locale: AppLocale): string => {
  const m = /^-?\d+(?:\.(\d+))?$/.exec(raw);
  return m ? intlNumber(Number(raw), m[1]?.length ?? 0, locale) : raw;
};

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "Monthly revenue and order count" → each field in the reader's words, listed their way. */
function measuredList(raw: string, w: WatchWords): string {
  const words = raw
    .split(/, | and /)
    .map((s, i) => (i === 0 ? s.charAt(0).toLowerCase() + s.slice(1) : s));
  const local = words.map((s) => {
    const key = keyOfEnglish("field", s);
    return key === null ? s : w.tr(`field.${key}`);
  });
  const list = new Intl.ListFormat(intlTag(w.locale), { type: "conjunction" }).format(local);
  return capitalise(list);
}

function logValue(name: string, raw: string, w: WatchWords): string | number {
  const { locale } = w;
  switch (name) {
    case "date":
      return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? dayMonthYear(raw, locale) : raw;
    case "weekday":
      return weekdayWord(raw, locale);
    case "noun": {
      const m = /^(.*?)(?: \(([A-Z]{3})\))?$/.exec(raw);
      const key = m ? keyOfEnglish("signal", m[1]!) : null;
      if (!m || key === null) return raw;
      return `${w.tr(`signal.${key}`)}${m[2] ? ` (${m[2]})` : ""}`;
    }
    case "actual":
    case "expected":
    case "mean":
    case "last7":
    case "prior7":
      return figure(raw, locale);
    case "factor":
    case "deviation":
      return decimals(raw, locale);
    case "data": {
      const key = keyOfEnglish("data", raw);
      return key === null ? raw : w.tr(`data.${key}`);
    }
    case "measured":
      return measuredList(raw, w);
    case "parts": {
      const sep = locale === "zh-Hans" ? "，" : ", ";
      return raw
        .split(", ")
        .map((p) => {
          if (p === "no field movement") return w.tr("part.none");
          const m = /^(\d+) (changed|new|removed)$/.exec(p);
          return m ? w.tr(`part.${m[2]}`, { count: Number(m[1]) }) : p;
        })
        .join(sep);
    }
    default:
      return plainValue(name, raw);
  }
}

/* ── said plainly (2026-11-23) ──
   The owner: pages a client "can't understand easily". Watching's stored
   lines stay as stored; these read them back into plain words for the
   screen, in every language, English included. A line that matches none of
   these is shown as before. */

/** The anomaly lines that carry their working in brackets: said as what happened. */
const PLAIN_LOG = new Set(["rose", "fell", "fellInterrupted"]);

/**
 * Pure: a noticed line said plainly ("Website visits jumped: 2,525 on
 * 18 Nov, 49% above what's usual, 2 days in a row."), through `plain` over
 * the watch's plain keys; null when the line is not one of PLAIN_LOG's, so
 * the caller shows it as it reads today. The working stays in the stored line.
 */
export function plainLogWords(
  text: string,
  w: WatchWords,
  plain: (key: string, values: Record<string, string | number>) => string,
): string | null {
  const m = matchStored(text, "watchWords.log", LOG_SHAPES);
  if (!m || !PLAIN_LOG.has(m.key)) return null;
  const values: Record<string, string | number> = {};
  for (const [name, raw] of Object.entries(m.values)) values[name] = logValue(name, raw, w);
  return plain(m.key, values);
}

/** Pure: one of the rules that would stop the watch, said plainly; null when it matches none. */
export function plainRuleWords(
  text: string,
  plain: (key: string, values: Record<string, string | number>) => string,
): string | null {
  const m = matchStored(text, "watchWords.rule");
  if (!m) return null;
  const values: Record<string, string | number> = {};
  for (const [name, raw] of Object.entries(m.values)) values[name] = plainValue(name, raw);
  return plain(m.key, values);
}
