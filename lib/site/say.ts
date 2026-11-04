// The website's server-built sentences, one source — L-4c of
// TASKS-LANGUAGES.md. Every sentence lib/site builds from data comes from
// the "siteWords" catalogue: English by default (messages/en.json), so the
// stored English is exactly what the code said before L-4, and the request's
// language at presentation (lib/site/localize.ts). Nothing stored is ever
// rewritten (rules 3 and 4): a stored English sentence is said again in
// another language only when SYB's own English for the same key and values
// reproduces it byte for byte.

import { intlNumber } from "../i18n/format";
import type { AppLocale } from "../i18n/locales";
import { intlTag } from "../i18n/locales";
import type { Tr } from "../i18n/tr";
import { englishTr } from "../i18n/tr";
import en from "../../messages/en.json";

/** The namespace of every sentence on this page. */
export const SITE_WORDS = "siteWords";

/** English, from messages/en.json — what the code always said. */
export const siteEnglish = (): Tr => englishTr(SITE_WORDS);

/** A figure at fixed decimals: English exactly as before (toFixed), another language its own way. */
export function fixed(n: number, decimals: number, locale: AppLocale): string {
  return locale === "en" ? n.toFixed(decimals) : intlNumber(n, decimals, locale);
}

/** A figure as the code wrote it (String(n)): English as before, another language its own digits. */
export function plain(n: number, locale: AppLocale): string {
  if (locale === "en") return String(n);
  const decimals = Number.isInteger(n) ? 0 : Math.min(String(n).split(".")[1]?.length ?? 0, 3);
  return intlNumber(n, decimals, locale);
}

/** Two sentences as one: English "A B"; Chinese "AB" — the join is the catalogue's. */
export function joinSentences(parts: readonly string[], tr: Tr): string {
  const kept = parts.filter((p) => p !== "");
  if (kept.length === 0) return "";
  return kept.slice(1).reduce((first, then) => tr("join", { first, then }), kept[0] as string);
}

/* ── saying a stored English sentence again ── */

type Messages = { [key: string]: string | Messages };

function source(key: string): string | null {
  let at: string | Messages | undefined = (en as unknown as Messages)[SITE_WORDS];
  for (const part of key.split(".")) {
    if (typeof at !== "object" || at === null) return null;
    at = at[part];
  }
  return typeof at === "string" ? at : null;
}

/** Placeholder values that are themselves stored sentences, said again in turn. */
const NESTED = new Set(["reason", "missing"]);

interface Shape {
  re: RegExp;
  names: string[];
}

const shapes = new Map<string, Shape | null>();

/** Pure: a regular expression for one plain-placeholder English message; null for plurals and selects. */
function shapeOf(key: string): Shape | null {
  if (shapes.has(key)) return shapes.get(key) ?? null;
  const src = source(key);
  let shape: Shape | null = null;
  if (src !== null && !/\{\s*\w+\s*,/.test(src)) {
    const names = [...src.matchAll(/\{(\w+)\}/g)].map((m) => m[1] as string);
    const mark = (n: string) => `\uE000${n}\uE001`;
    const text = siteEnglish()(key, Object.fromEntries(names.map((n) => [n, mark(n)])));
    const order: string[] = [];
    const pattern = text
      .split(/(\uE000\w+\uE001)/)
      .map((piece) => {
        const m = /^\uE000(\w+)\uE001$/.exec(piece);
        if (!m) return piece.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        order.push(m[1] as string);
        return "([\\s\\S]+?)";
      })
      .join("");
    shape = { re: new RegExp(`^${pattern}$`), names: order };
  }
  shapes.set(key, shape);
  return shape;
}

/** Every stored sentence lib/site writes in English, by catalogue key — the order is the match order. */
export const STORED_KEYS = [
  "fetch.scheme",
  "fetch.credentials",
  "fetch.noResolve",
  "fetch.private",
  "fetch.notAddress",
  "fetch.ports",
  "fetch.redirects",
  "audit.noSite",
  "audit.badSite",
  "audit.cooldown",
  "audit.running",
  "audit.homeUnreadable",
  "audit.homeUnreadableBare",
  "audit.failed",
  "walk.homeStatus",
  "walk.homeUnread",
  "walk.unread",
  "walk.unloaded",
  "walk.answers",
  "walk.note.counted",
  "walk.note.noAddToCart",
  "walk.note.assumedCart",
  "walk.note.cartEmpty",
  "walk.note.booking",
  "walk.note.external",
  "walk.note.cartOnly",
  "walk.note.contact",
  "walk.note.checkoutOnly",
  "walk.note.none",
  "pagespeed.noMeasurement",
  "pagespeed.runtime",
  "pagespeed.quotaWeek",
  "pagespeed.unreachable",
  "pagespeed.quotaKeyed",
  "pagespeed.quotaShared",
  "pagespeed.couldntLoad",
  "pagespeed.refused",
  "pagespeed.badKey",
  "pagespeed.failed",
  "pagespeed.failedBare",
  "pagespeed.noKey",
  "pagespeed.stopped",
  "pagespeed.weekUsed",
  "pagespeed.short",
  "euro.needs",
  "euro.needsBecause",
  "euro.zero",
  "euro.inside",
  "euro.notSpeed",
  "euro.missing.list",
  "euro.missing.zero",
] as const;

/** Pure: a stored sentence's key and values, when SYB's English for them is exactly it. */
export function parseStored(
  stored: string,
  keys: readonly string[] = STORED_KEYS,
): { key: string; values: Record<string, string> } | null {
  const english = siteEnglish();
  for (const key of keys) {
    const shape = shapeOf(key);
    const m = shape?.re.exec(stored);
    if (!shape || !m) continue;
    const values = Object.fromEntries(shape.names.map((n, i) => [n, m[i + 1] as string]));
    if (english(key, values) === stored) return { key, values };
  }
  return null;
}

/**
 * A stored English sentence in the reader's language: said again from the
 * catalogue when it is one of SYB's own (its values as stored, a nested
 * reason said again in turn), and shown as stored when it is not — another
 * system's words, or an older wording.
 */
export function sayStored(
  stored: string,
  tr: Tr,
  locale: AppLocale,
  keys: readonly string[] = STORED_KEYS,
): string {
  if (locale === "en") return stored;
  const parsed = parseStored(stored, keys);
  if (!parsed) return stored;
  const values: Record<string, string> = {};
  for (const [name, value] of Object.entries(parsed.values)) {
    values[name] = NESTED.has(name) ? sayStored(value, tr, locale, keys) : value;
  }
  if (parsed.key === "euro.missing.list")
    values["list"] = missingList(values["list"] ?? "", tr, locale);
  return tr(parsed.key, values);
}

const MISSING = ["visits", "orders", "revenue"] as const;

/** "monthly website visits, monthly orders" in the reader's language, when every name is SYB's. */
function missingList(list: string, tr: Tr, locale: AppLocale): string {
  const english = siteEnglish();
  const names = list
    .split(", ")
    .map((n) => MISSING.find((m) => english(`euro.missing.${m}`) === n));
  if (names.some((n) => n === undefined)) return list;
  const words = names.map((n) => tr(`euro.missing.${n}`));
  return new Intl.ListFormat(intlTag(locale), { style: "long", type: "conjunction" }).format(words);
}
