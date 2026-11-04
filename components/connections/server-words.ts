// What the server says on /connections, in the reader's language — L-4c of
// TASKS-LANGUAGES.md. Pure, and safe in the browser.
//
// The connection routes refuse in English (`payload.error`), and a
// connection's `last_error` is stored as it was written (rule 4): a sync's
// "ProviderError: shopify: network failure after 3 attempts", a paused Meta
// connection's classified sentence (lib/execution/meta-errors.ts), Google's
// GOOGLE_AUTH_LOST. Nothing stored is rewritten. At presentation, a
// sentence is said again from the "connectionsWords" catalogue only when it
// is one of SYB's own: when SYB's English for a key, with the values read
// back out of the sentence, reproduces it byte for byte (lib/site/say.ts's
// approach). Anything else — a provider's own words, an older wording, a
// refusal another stage translates — is shown exactly as it came.
//
// server-words.test.ts holds the catalogue's English to the code that
// writes each sentence.

import type { AppLocale } from "../../lib/i18n/locales";
import type { Tr } from "../../lib/i18n/tr";
import { englishTr } from "../../lib/i18n/tr";
import en from "../../messages/en.json";

/** The namespace of every server-built sentence on /connections. */
export const CONNECTIONS_WORDS = "connectionsWords";

const english = (): Tr => englishTr(CONNECTIONS_WORDS);

type Messages = { [key: string]: string | Messages };

function subtree(path: string): Messages | null {
  let at: string | Messages | undefined = (en as unknown as Messages)[CONNECTIONS_WORDS];
  for (const part of path.split(".")) {
    if (typeof at !== "object" || at === null) return null;
    at = at[part];
  }
  return typeof at === "object" && at !== null ? at : null;
}

function leaves(tree: Messages, prefix: string): [string, string][] {
  const out: [string, string][] = [];
  for (const [k, v] of Object.entries(tree)) {
    const key = `${prefix}.${k}`;
    if (typeof v === "string") out.push([key, v]);
    else out.push(...leaves(v, key));
  }
  return out;
}

/** The provider ids the measurement connectors prefix their sentences with, as their brands. */
export const PROVIDER_BRANDS: Readonly<Record<string, string>> = {
  shopify: "Shopify",
  stripe: "Stripe",
  woocommerce: "WooCommerce",
  ga4: "Google Analytics",
  "search console": "Search Console",
  meta: "Meta",
  square: "Square",
};

/** Placeholders that are figures: they must read as digits. */
const FIGURES = new Set(["attempts", "status", "code", "max"]);
/** Of those, the counts a plural chooses on; a status or a code stays as written (no grouping). */
const COUNTS = new Set(["attempts", "max"]);

interface Shape {
  key: string;
  re: RegExp;
  names: string[];
  /** The English with its placeholders taken out: longer goes first, so a fuller sentence wins. */
  literal: number;
}

let shapes: Shape[] | null = null;

/** Pure: a regular expression for one English message (plain placeholders only), its placeholders as groups. */
function shapeOf(key: string, src: string): Shape {
  const mark = (n: string) => `\uE000${n}\uE001`;
  const values: Record<string, string> = {};
  for (const m of src.matchAll(/\{(\w+)\}/g)) values[m[1] as string] = mark(m[1] as string);
  const text = english()(key, values);
  const names: string[] = [];
  let literal = 0;
  const pattern = text
    .split(/(\uE000\w+\uE001)/)
    .map((piece) => {
      const m = /^\uE000(\w+)\uE001$/.exec(piece);
      if (!m) {
        literal += piece.length;
        return piece.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      }
      names.push(m[1] as string);
      return "([\\s\\S]+?)";
    })
    .join("");
  return { key, re: new RegExp(`^${pattern}$`), names, literal };
}

function allShapes(): Shape[] {
  if (shapes === null) {
    const said = subtree("said");
    shapes = (said ? leaves(said, "said") : [])
      .map(([key, src]) => shapeOf(key, src))
      .sort((a, b) => b.literal - a.literal);
  }
  return shapes;
}

/** Pure: the English the catalogue holds at `key` (one of the helper subtrees). */
function englishAt(path: string): [string, string][] {
  const tree = subtree(path);
  return tree ? leaves(tree, path) : [];
}

/** Pure: a stored sentence's key and values, when SYB's English for them is exactly it. */
export function parseServer(
  stored: string,
): { key: string; values: Record<string, string | number> } | null {
  const tr = english();
  for (const shape of allShapes()) {
    const m = shape.re.exec(stored);
    if (!m) continue;
    const values: Record<string, string | number> = {};
    let figures = true;
    shape.names.forEach((n, i) => {
      const v = m[i + 1] as string;
      if (FIGURES.has(n) && !/^\d+$/.test(v)) figures = false;
      values[n] = COUNTS.has(n) ? Number(v) : v;
    });
    if (!figures) continue;
    if (tr(shape.key, values) === stored) return { key: shape.key, values };
  }
  return null;
}

/** One value said again: a nested sentence of SYB's, a label or brand it knows; null when it can't be. */
function sayValue(name: string, value: string | number, tr: Tr): string | number | null {
  if (typeof value === "number") return value;
  const en = english();
  if (name === "provider") return PROVIDER_BRANDS[value] ?? value;
  if (name === "label") {
    const hit = englishAt("label").find(([, text]) => text === value);
    return hit ? tr(hit[0]) : value;
  }
  if (name === "why") {
    const hit = englishAt("part.why").find(([, text]) => text === value);
    return hit ? tr(hit[0]) : null;
  }
  if (name === "parts") {
    const said = value.split(en("part.sep")).map((part) => {
      for (const key of ["part.extra", "part.missing"]) {
        const shape = shapeOf(key, "{scopes}");
        const m = shape.re.exec(part);
        if (m && en(key, { scopes: m[1] as string }) === part) {
          return tr(key, { scopes: m[1] as string });
        }
      }
      return null;
    });
    return said.every((s): s is string => s !== null) ? said.join(tr("part.sep")) : null;
  }
  return value;
}

/** The class name a sync stores before the message ("ProviderError: …"). */
const NAMED = /^([A-Za-z]*Error): ([\s\S]+)$/;

/**
 * A server sentence in the reader's language: said again from the
 * catalogue when it is one of SYB's own, and shown as it came when it is
 * not. English is always as it came.
 */
export function sayServer(text: string, tr: Tr, locale: AppLocale): string {
  if (locale === "en" || text === "") return text;
  const named = NAMED.exec(text);
  // A stored class name ("ProviderError: …") is not part of SYB's sentence: read past it first.
  const parsed = (named ? parseServer(named[2] as string) : null) ?? parseServer(text);
  if (!parsed) return text;
  const values: Record<string, string | number> = {};
  for (const [name, value] of Object.entries(parsed.values)) {
    const said = sayValue(name, value, tr);
    if (said === null) return text;
    values[name] = said;
  }
  return tr(parsed.key, values);
}
