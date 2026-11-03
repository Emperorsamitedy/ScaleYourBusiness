// Stored English, read back in the reader's language — L-4a of
// TASKS-LANGUAGES.md.
//
// Some sentences SYB writes are kept as they were written: a watch-log
// line, a proposal's own "what approving sends", a refusal inside a
// stored report. Rules 4 and 7 keep them as they are, so they are
// translated at presentation only: the stored text is matched against
// the English catalogue messages it was written from (each message's
// placeholders become capture groups), and the match is formatted again
// with the reader's translator and the captured values. Anything that
// doesn't match — older wording, text from a model, a name — prints as
// it was stored. Nothing here writes.
//
// Pure and safe in the browser: the English catalogue is the one source.

import type { MessageFormatElement } from "@formatjs/icu-messageformat-parser";
import { isArgumentElement, isLiteralElement, parse } from "@formatjs/icu-messageformat-parser";
import en from "../../messages/en.json";
import type { Tr } from "./tr";

type Tree = { [key: string]: string | Tree };

export interface StoredMatch {
  /** The message's key, relative to the namespace searched. */
  key: string;
  /** Each placeholder's captured text. */
  values: Record<string, string>;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Pure: a whole-text pattern for an English message whose only ICU parts
 * are plain `{arguments}` — null for one with a plural, select or tag (those
 * aren't read back). A placeholder used twice must capture the same text.
 * `shapes` narrows what a placeholder may capture (a regex source), where
 * two neighbours could split the text two ways ("Google Analytics traffic").
 */
export type Shapes = Readonly<Record<string, string>>;

export function storedPattern(message: string, shapes: Shapes = {}): RegExp | null {
  let ast: MessageFormatElement[];
  try {
    ast = parse(message);
  } catch {
    return null;
  }
  const seen = new Set<string>();
  let source = "";
  for (const el of ast) {
    if (isLiteralElement(el)) source += escape(el.value);
    else if (isArgumentElement(el)) {
      if (seen.has(el.value)) source += `\\k<${el.value}>`;
      else {
        seen.add(el.value);
        source += `(?<${el.value}>${shapes[el.value] ?? ".+?"})`;
      }
    } else return null;
  }
  return new RegExp(`^${source}$`, "su");
}

const flatCache = new Map<string, [string, string, RegExp][]>();

/** The English messages under a dotted namespace ("watchWords.log"), each with its pattern. */
export function englishPatterns(
  namespace: string,
  shapes: Shapes = {},
): [string, string, RegExp][] {
  const id = `${namespace}|${JSON.stringify(shapes)}`;
  let list = flatCache.get(id);
  if (list) return list;
  let node: string | Tree | undefined = en as unknown as Tree;
  for (const part of namespace.split(".")) {
    node = typeof node === "object" ? node[part] : undefined;
  }
  list = [];
  const walk = (tree: Tree, prefix: string) => {
    for (const [k, v] of Object.entries(tree)) {
      const key = prefix ? `${prefix}.${k}` : k;
      if (typeof v === "string") {
        const re = storedPattern(v, shapes);
        if (re) list!.push([key, v, re]);
      } else walk(v, key);
    }
  };
  if (typeof node === "object") walk(node, "");
  // The most specific first: more literal text before less.
  list.sort((a, b) => literalLength(b[1]) - literalLength(a[1]));
  flatCache.set(id, list);
  return list;
}

const literalLength = (m: string) => m.replace(/\{[^{}]*\}/g, "").length;

/** Pure: which English message under `namespace` a stored text was written from, and its values. */
export function matchStored(
  text: string,
  namespace: string,
  shapes: Shapes = {},
): StoredMatch | null {
  for (const [key, , re] of englishPatterns(namespace, shapes)) {
    const m = re.exec(text);
    if (m) return { key, values: { ...(m.groups ?? {}) } };
  }
  return null;
}

/** A captured whole number as a number (so a plural can count it); anything else as it was. */
export const plainValue = (_: string, raw: string): string | number =>
  /^\d{1,15}$/.test(raw) ? Number(raw) : raw;

/**
 * Pure: a stored English sentence in the reader's language — the matched
 * message through `tr` (a translator over the same namespace), each value
 * passed through `value` first (a date, a noun, a count). The stored text
 * itself when nothing matches.
 */
export function readStored(
  text: string,
  namespace: string,
  tr: Tr,
  value: (name: string, raw: string) => string | number = plainValue,
  shapes: Shapes = {},
): string {
  const m = matchStored(text, namespace, shapes);
  if (!m) return text;
  const values: Record<string, string | number> = {};
  for (const [name, raw] of Object.entries(m.values)) values[name] = value(name, raw);
  return tr(m.key, values);
}
