// What language the model writes in — L-5 of TASKS-LANGUAGES.md, rule 5.
//
// Two readers, two languages:
//   · the PERSON — the owner or a teammate reading SYB: interview turns,
//     the report, chat answers, goal reviews, briefs. Their language is
//     users.language / the request's locale through the status gate
//     (lib/i18n/server requestLocale), or, for a job no one is waiting on,
//     the owner's own (ownerLanguage in ./language-of, through the same gate).
//   · the business's CUSTOMERS — the support widget, reply drafts, review
//     replies, posts, campaign emails, follow-ups. Their language is the
//     business's setting (business_profiles.language, lib/i18n/service
//     businessLocale); the gate does not apply to it.
//
// Every instruction here is written in English and names the language and
// the register (L-1's: usted, Sie, vous, Ön, вы, 您). Each prompt carries
// it AFTER anything cached (rule 8), so a cached prefix stays byte-identical
// across languages; most sites cache nothing and append it to the end.
//
// What the code later parses (JSON keys, enum values, ids, field keys)
// stays as specified: only the human-readable text changes language.
// Facts don't change language either (rule 4): extraction prompts carry
// FACTS_AS_GIVEN instead, so a German answer is stored in German.

// Pure: safe anywhere. Reading whose language it is lives in ./language-of.ts.

import type { AppLocale } from "../i18n/locales";

/** Each language's English name, for the model. */
export const LANGUAGE_FOR_MODEL: Readonly<Record<AppLocale, string>> = {
  en: "English",
  "es-ES": "Spanish (Spain)",
  "de-DE": "German",
  "fr-FR": "French (France)",
  "hu-HU": "Hungarian",
  "ru-RU": "Russian",
  "zh-Hans": "Simplified Chinese",
};

/** The register L-1 chose for each language; English has none to choose. */
export const REGISTER_FOR_MODEL: Readonly<Record<AppLocale, string | null>> = {
  en: null,
  "es-ES": 'formally, as "usted"',
  "de-DE": 'formally, as "Sie"',
  "fr-FR": 'formally, as "vous"',
  "hu-HU": 'formally, as "Ön", with third-person verbs',
  "ru-RU": 'formally, as "вы" (lower case)',
  "zh-Hans": 'politely, as "您", with full-width punctuation',
};

/** How each instruction begins: the tests find the line by it. */
export const LANGUAGE_HEADING = "OUTPUT LANGUAGE:";

const KEEP_STRUCTURE =
  "Keep JSON keys, enum values, ids, codes and field keys exactly as specified, in English; " +
  "only the human-readable text is written in that language. Names, quotes and figures stay " +
  "exactly as given, and no currency is converted.";

function addressing(locale: AppLocale, whom: string): string {
  const register = REGISTER_FOR_MODEL[locale];
  return register ? `, addressing ${whom} ${register}` : "";
}

/** For text the person reads (rule 5's first sentence). */
export function ownerLanguageLine(locale: AppLocale): string {
  const name = LANGUAGE_FOR_MODEL[locale];
  return `${LANGUAGE_HEADING} Write every sentence the owner reads in ${name}${addressing(locale, "them")}. ${KEEP_STRUCTURE}`;
}

/**
 * For text the business's customers read (rule 5's second sentence): the
 * business's own language, whatever language the reader of SYB uses.
 */
export function customerLanguageLine(locale: AppLocale): string {
  const name = LANGUAGE_FOR_MODEL[locale];
  return `${LANGUAGE_HEADING} Write the text the business's customers read in ${name}, the business's own language for its customers${addressing(locale, "the customer")}. ${KEEP_STRUCTURE}`;
}

/**
 * For a reply to something a customer wrote (the support widget's answer,
 * a support reply draft, a review reply) — decided by the owner on
 * 2026-11-03: the reply is in the language the customer wrote in, when it
 * is one of the seven SYB writes (so every check on a reply, such as the
 * review reply's no-offer check, still reads it); otherwise, or when the
 * language can't be told, in the business's own language. What SYB starts
 * itself (posts, campaign emails, follow-ups) stays in the business's.
 */
export function replyLanguageLine(business: AppLocale): string {
  const seven = Object.values(LANGUAGE_FOR_MODEL).join(", ");
  const name = LANGUAGE_FOR_MODEL[business];
  return (
    `${LANGUAGE_HEADING} Write the reply in the language the customer wrote in, when it is one of: ${seven}. ` +
    `If they wrote in another language, or you can't tell which, write it in ${name}, the business's own language for its customers. ` +
    `Address the customer formally, as that language does (usted, Sie, vous, Ön with third-person verbs, вы, 您). ` +
    KEEP_STRUCTURE
  );
}

/**
 * For a brief whose parts have two readers: the person's language for
 * what the owner reads, the business's for what customers hear.
 */
export function splitLanguageLine(
  owner: AppLocale,
  customers: AppLocale,
  ownerParts: string,
  customerParts: string,
): string {
  const ownerName = LANGUAGE_FOR_MODEL[owner];
  const customerName = LANGUAGE_FOR_MODEL[customers];
  return (
    `${LANGUAGE_HEADING} Write ${ownerParts} — what the owner reads — in ${ownerName}${addressing(owner, "them")}. ` +
    `Write ${customerParts} — what the business's customers hear — in ${customerName}, the business's own language for its customers${addressing(customers, "the customer")}. ` +
    KEEP_STRUCTURE
  );
}

/** For extraction: facts are stored as given (rule 4), in whatever language they came. */
export const FACTS_AS_GIVEN =
  "The text may be in any language. Copy names, quotes and text values in the language they are written in; never translate them.";

/** An instruction placed after the cached prefix, as its own uncached system block. */
export function languageBlock(line: string): { type: "text"; text: string } {
  return { type: "text", text: line };
}

/** A system prompt with the instruction appended — for the sites that cache nothing. */
export function withLanguage(system: string, line: string): string {
  return `${system}\n\n${line}`;
}
