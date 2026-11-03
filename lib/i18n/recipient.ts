// Words for someone who isn't looking at a screen — L-6 of
// TASKS-LANGUAGES.md: the emails, phone alerts and files SYB sends or
// hands over. They are written outside any request, so next-intl's request
// config (i18n/request.ts, the cookie) can't choose the language: the
// sender says whose message it is, the gate decides which language that
// person may have, and next-intl's createTranslator does the rest over
// messages/<locale>.json.
//
// Who reads what (the rules this file holds, pure):
//   · a person SYB writes to — the weekly summary, a phone alert, a sign-in
//     link, an invite, the owner's support notice — reads THEIR language
//     (users.language), but only while it is open to them: a language in
//     review is theirs only if they are a named reviewer (rule 6). Otherwise
//     English. A sign-in link asked for before there is a language on any
//     account uses the language the link carries (login_tokens.language).
//   · the business's customers — a campaign email's fixed footer, the
//     unsubscribe page — read the business's language
//     (business_profiles.language). A language in review reaches them only
//     when the business itself is under review: its account, or its owner's
//     address, is named in LANGUAGE_REVIEW_ACCOUNTS. Only a reviewer could
//     have chosen that language for the business in the first place, and
//     taking someone off the list turns their customers back to English.
//
// English is bundled; the six others are loaded on first use and kept.
// Nothing here reads a cookie, a session or the database, so the
// unsubscribe page's import fence (lib/unsubscribe/structure.test.ts) can
// allow it.

import { createTranslator } from "next-intl";
import en from "../../messages/en.json";
import type { AppLocale } from "./locales";
import { resolveLanguage } from "./locales";
import { isLanguageReviewer } from "./review";

/** key → text, over one namespace (the same shape as lib/i18n/tr's Tr). */
export type Tr = (key: string, values?: Record<string, string | number>) => string;

/** key → text with tags, each tag a function of its own (already written) chunks. */
export type Markup = (
  key: string,
  values: Record<string, string | number | ((chunks: string) => string)>,
) => string;

export interface Words {
  locale: AppLocale;
  t: Tr;
  markup: Markup;
}

type Catalogue = Record<string, unknown>;

const loaded = new Map<AppLocale, Catalogue>([["en", en as Catalogue]]);

/** One language's catalogue: English at once, the others read on first use and kept. */
export async function catalogueFor(locale: AppLocale): Promise<Catalogue> {
  const hit = loaded.get(locale);
  if (hit) return hit;
  const messages = (await import(`../../messages/${locale}.json`)).default as Catalogue;
  loaded.set(locale, messages);
  return messages;
}

/** Pure: a translator over one namespace of a catalogue already in hand. */
export function wordsFrom(locale: AppLocale, messages: Catalogue, namespace: string): Words {
  const t = createTranslator({
    locale,
    messages: messages as typeof en,
    namespace: namespace as "common",
  }) as unknown as {
    (key: string, values?: Record<string, string | number>): string;
    markup(key: string, values: Record<string, unknown>): string;
  };
  return {
    locale,
    t: (key, values) => t(key, values),
    markup: (key, values) => t.markup(key, values),
  };
}

const english = new Map<string, Words>();

/** English for one namespace, at once — the default every composer falls back to. */
export function englishWords(namespace: string): Words {
  let w = english.get(namespace);
  if (!w) {
    w = wordsFrom("en", en as Catalogue, namespace);
    english.set(namespace, w);
  }
  return w;
}

/** A recipient's words for one namespace. */
export async function wordsFor(locale: AppLocale, namespace: string): Promise<Words> {
  if (locale === "en") return englishWords(namespace);
  return wordsFrom(locale, await catalogueFor(locale), namespace);
}

/**
 * Pure: the language a message to this person is written in. `language` is
 * theirs (users.language, or the link's own for a sign-in before any
 * account has one); `who` is the identity the gate checks — their address,
 * and the account the message is about, when there is one.
 */
export function personLocale(
  language: unknown,
  who: { email: string; account_id?: string | null },
  allowlist?: string | null,
): AppLocale {
  const reviewer = isLanguageReviewer(
    { email: who.email, account_id: who.account_id ?? "" },
    allowlist === undefined ? process.env.LANGUAGE_REVIEW_ACCOUNTS : allowlist,
  );
  return resolveLanguage(language, reviewer);
}

/**
 * Pure: the language the business's customers read. A review language only
 * while the business is under review: its account, or its owner's address,
 * on the review list.
 */
export function customerLocale(
  language: unknown,
  business: { account_id: string; owner_email: string | null },
  allowlist?: string | null,
): AppLocale {
  const raw = allowlist === undefined ? process.env.LANGUAGE_REVIEW_ACCOUNTS : allowlist;
  const reviewer = isLanguageReviewer(
    { account_id: business.account_id, email: business.owner_email ?? "" },
    raw,
  );
  return resolveLanguage(language, reviewer);
}
