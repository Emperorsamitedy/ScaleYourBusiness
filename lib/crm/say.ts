// Saying one of SYB's own English sentences again in the reader's language
// — L-4c of TASKS-LANGUAGES.md, for Customers (`customersWords`) and
// Support (`supportWords`). The same rule as lib/site/say.ts, over any
// namespace: a sentence that arrives already written in English — a
// refusal thrown deep in lib/, a stored outcome note, a stored proposal
// summary — is said again from the catalogue only when SYB's English for
// one of the listed keys, with the values read back out of it, reproduces
// it byte for byte. Anything else (another system's words, an older
// wording, the owner's own) is shown as it came. Nothing stored is ever
// rewritten (rules 3 and 4): this is presentation only.
//
// Values read back out of a sentence are strings. A value that is a whole
// number is handed to the catalogue as a number, so the reader's language
// groups it and picks its plural form; one that is an ISO day is said as
// the reader's date.

import { dayMonthYear, intlNumber } from "../i18n/format";
import type { AppLocale } from "../i18n/locales";
import type { Tr } from "../i18n/tr";
import { englishTr } from "../i18n/tr";
import en from "../../messages/en.json";

type Messages = { [key: string]: string | Messages };

/** A sentence's key and the values read back out of it. */
export interface Parsed {
  key: string;
  values: Record<string, string>;
}

interface Shape {
  re: RegExp;
  names: string[];
}

/** Pure: the English message for `namespace.key` as written in messages/en.json, or null. */
function source(namespace: string, key: string): string | null {
  let at: string | Messages | undefined = (en as unknown as Messages)[namespace];
  for (const part of key.split(".")) {
    if (typeof at !== "object" || at === null) return null;
    at = at[part];
  }
  return typeof at === "string" ? at : null;
}

/** A value as the catalogue takes it: a whole number as a number, an ISO day as the reader's date. */
export function valueFor(value: string, locale: AppLocale): string | number {
  if (/^\d{1,9}$/.test(value)) return Number(value);
  if (locale !== "en" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return dayMonthYear(value, locale);
  return value;
}

export interface Sayer {
  /** Pure: a sentence's key and values, when SYB's English for them is exactly it. */
  parse(stored: string): Parsed | null;
  /** The sentence in the reader's language when it is one of SYB's own; as it came otherwise. */
  say(stored: string, tr: Tr, locale: AppLocale): string;
}

/**
 * A sayer over `keys` of `namespace`, tried in order. Plain-placeholder
 * messages are matched by shape; a plural message is matched by trying each
 * whole number in the sentence as its `count` (and `n`). `nested` names the
 * placeholders whose values are themselves SYB sentences, said again in turn.
 */
export function sayer(
  namespace: string,
  keys: readonly string[],
  opts: {
    nested?: readonly string[];
    /** A value said the reader's way by name (money, a list …); the default is valueFor. */
    format?: (
      name: string,
      value: string,
      tr: Tr,
      locale: AppLocale,
    ) => string | number | undefined;
  } = {},
): Sayer {
  const english = englishTr(namespace);
  const nested = new Set(opts.nested ?? []);
  const shapes = new Map<string, Shape | "plural" | null>();

  const shapeOf = (key: string): Shape | "plural" | null => {
    if (shapes.has(key)) return shapes.get(key) ?? null;
    const src = source(namespace, key);
    let shape: Shape | "plural" | null = null;
    if (src !== null && /\{\s*count\s*,\s*plural/.test(src)) shape = "plural";
    else if (src !== null && !/\{\s*\w+\s*,/.test(src)) {
      const names = [...src.matchAll(/\{(\w+)\}/g)].map((m) => m[1] as string);
      const mark = (n: string) => `\uE000${n}\uE001`;
      const text = english(key, Object.fromEntries(names.map((n) => [n, mark(n)])));
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
  };

  const parse = (stored: string): Parsed | null => {
    for (const key of keys) {
      const shape = shapeOf(key);
      if (shape === null) continue;
      if (shape === "plural") {
        for (const m of stored.matchAll(/\d+/g)) {
          const values = { count: m[0], n: m[0] };
          if (english(key, { count: Number(m[0]), n: m[0] }) === stored) return { key, values };
        }
        continue;
      }
      const m = shape.re.exec(stored);
      if (!m) continue;
      const values = Object.fromEntries(shape.names.map((n, i) => [n, m[i + 1] as string]));
      if (english(key, values) === stored) return { key, values };
    }
    return null;
  };

  const say = (stored: string, tr: Tr, locale: AppLocale): string => {
    if (locale === "en") return stored;
    const parsed = parse(stored);
    if (!parsed) return stored;
    const values: Record<string, string | number> = {};
    for (const [name, value] of Object.entries(parsed.values)) {
      if (nested.has(name)) values[name] = say(value, tr, locale);
      else values[name] = opts.format?.(name, value, tr, locale) ?? valueFor(value, locale);
    }
    if ("n" in parsed.values && "count" in parsed.values) {
      values["n"] = intlNumber(Number(parsed.values["n"]), 0, locale);
    }
    return tr(parsed.key, values);
  };

  return { parse, say };
}
