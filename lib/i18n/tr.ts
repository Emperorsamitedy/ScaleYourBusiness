// A plain translator over one catalogue namespace — L-3a of
// TASKS-LANGUAGES.md, the intake's pattern (components/intake/words.ts)
// made general. Pure view helpers take a `Tr` so they stay testable
// without React, and default to English from messages/en.json — so
// English has one source, and what a screen said before is what it still
// says. Components pass next-intl's translator for the request's locale
// (components/sheet/useTr.ts).

import { createTranslator } from "next-intl";
import en from "../../messages/en.json";

/** key → text, over one namespace. */
export type Tr = (key: string, values?: Record<string, string | number>) => string;

const cache = new Map<string, Tr>();

/** English for one namespace ("report", "watch" …), from messages/en.json. */
export function englishTr(namespace: string): Tr {
  let tr = cache.get(namespace);
  if (!tr) {
    const t = createTranslator({
      locale: "en",
      messages: en,
      namespace: namespace as "common",
    }) as unknown as Tr;
    tr = (key, values) => t(key, values);
    cache.set(namespace, tr);
  }
  return tr;
}
