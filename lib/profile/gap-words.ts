// What answering a gap buys, in the reader's language — L-4a of
// TASKS-LANGUAGES.md. Deterministic copy from the question's priority and
// how many follow-ups it opens (lib/profile/factsheet gapBuys), from the
// "reportWords" catalogue. A stored report keeps the English it was made
// with; the screens read it back here. Pure and safe in the browser.

import type { AppLocale } from "../i18n/locales";
import type { Tr } from "../i18n/tr";
import { englishTr } from "../i18n/tr";

const PRIORITIES = new Set(["core", "important", "deep"]);

/** Pure: the "what answering buys" line for a priority and a follow-up count. */
export function gapBuysText(
  priority: string | null | undefined,
  unlockCount: number,
  tr: Tr = englishTr("reportWords"),
): string {
  const p = priority && PRIORITIES.has(priority) ? priority : "context";
  return unlockCount > 0 ? tr(`gap.${p}Opens`, { count: unlockCount }) : tr(`gap.${p}`);
}

/** Pure: a stored English line in `locale`; the stored line itself when it isn't one of ours. */
export function gapBuysWords(
  stored: string,
  priority: string | null | undefined,
  tr: Tr,
  locale: AppLocale,
): string {
  if (locale === "en") return stored;
  const m = / and opens (\d+) follow-ups?$/.exec(stored);
  const count = m ? Number(m[1]) : 0;
  return gapBuysText(priority, count) === stored ? gapBuysText(priority, count, tr) : stored;
}
