// The bank's words in a person's language — L-2 of TASKS-LANGUAGES.md.
//
// The English bank (specs/question-bank-v1.json) is the single source of
// structure: ids, codes, conditions, writes_to, types. A language overlay
// (specs/question-bank-v1.<locale>.json, stored per bank version in
// bank_overlays) holds only words, keyed by the bank's own ids. This module
// reads them: given an overlay — or none, for English — it answers "what
// does this prompt, help line, option or entity field say?", falling back
// to the English when an overlay lacks a string (the linter refuses such
// an overlay, so the fallback is a seatbelt, not a path).
//
// Nothing here changes what is stored: answers stay codes and values
// exactly as given (rule 4 of the plan). Only what a person reads changes.

import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import { bankOverlays, bankVersions } from "../../db/schema";
import type { AppLocale } from "../i18n/locales";
import { DEFAULT_LOCALE } from "../i18n/locales";

/** An overlay's words, as the file (and bank_overlays.words) holds them. */
export interface OverlayWords {
  questions?: Record<
    string,
    { prompt?: string; help_text?: string; option_labels?: Record<string, string> }
  >;
  entity_schemas?: Record<string, { label?: string; fields?: Record<string, string> }>;
  vocabularies?: Record<string, Record<string, string>>;
}

/** The words a screen reads, in one language. English is the bank itself. */
export interface BankWords {
  locale: AppLocale;
  /** A question's prompt; `en` is the bank's own. */
  prompt(questionId: string, en: string): string;
  /** A question's help line, or null when the bank has none. */
  help(questionId: string, en: string | null): string | null;
  /**
   * An option's label: the question's own option_labels first, then the
   * vocabulary's words, then `en` (the bank's option label, or the
   * humanised code).
   */
  option(vocabularyId: string, code: string, en: string, questionId?: string): string;
  /** An entity schema's name ("Product or service"). */
  entityLabel(schema: string, en: string): string;
  /** An entity sub-field's prompt. */
  entityField(schema: string, key: string, en: string): string;
}

const present = (s: string | undefined): s is string => typeof s === "string" && s.trim() !== "";

/** Pure: the words of one overlay — or English, with none. */
export function bankWords(locale: AppLocale, overlay: OverlayWords | null): BankWords {
  const o = locale === DEFAULT_LOCALE ? null : overlay;
  return {
    locale: o ? locale : DEFAULT_LOCALE,
    prompt: (id, en) => {
      const t = o?.questions?.[id]?.prompt;
      return present(t) ? t : en;
    },
    help: (id, en) => {
      if (en === null || en.trim() === "") return null;
      const t = o?.questions?.[id]?.help_text;
      return present(t) ? t : en;
    },
    option: (vocabularyId, code, en, questionId) => {
      const own = questionId ? o?.questions?.[questionId]?.option_labels?.[code] : undefined;
      if (present(own)) return own;
      const t = o?.vocabularies?.[vocabularyId]?.[code];
      return present(t) ? t : en;
    },
    entityLabel: (schema, en) => {
      const t = o?.entity_schemas?.[schema]?.label;
      return present(t) ? t : en;
    },
    entityField: (schema, key, en) => {
      const t = o?.entity_schemas?.[schema]?.fields?.[key];
      return present(t) ? t : en;
    },
  };
}

/** English: the bank's own words, no lookup. */
export const ENGLISH_WORDS: BankWords = bankWords(DEFAULT_LOCALE, null);

// Per process, per (bank version, locale): an overlay is fixed once loaded,
// and a new bank version is a new key.
const cache = new Map<string, Promise<OverlayWords | null>>();

/** Test/bank-reload hook. */
export function resetBankWordsCache(): void {
  cache.clear();
}

/** The current bank's words in a language; English (or a language with no overlay) is the bank itself. */
export async function loadBankWords(locale: AppLocale): Promise<BankWords> {
  if (locale === DEFAULT_LOCALE) return ENGLISH_WORDS;
  const [current] = await db
    .select({ version: bankVersions.version })
    .from(bankVersions)
    .where(eq(bankVersions.is_current, true));
  if (!current) return ENGLISH_WORDS;
  const key = `${current.version}\u0000${locale}`;
  let pending = cache.get(key);
  if (!pending) {
    pending = db
      .select({ words: bankOverlays.words })
      .from(bankOverlays)
      .where(and(eq(bankOverlays.bank_version, current.version), eq(bankOverlays.locale, locale)))
      .then(([row]) => (row ? (row.words as OverlayWords) : null));
    // A failed read is not cached: the next request tries again.
    pending.catch(() => cache.delete(key));
    cache.set(key, pending);
  }
  return bankWords(locale, await pending);
}
