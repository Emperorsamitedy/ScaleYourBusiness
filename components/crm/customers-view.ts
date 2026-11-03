// Pure read-model for the customers screen (the owner's instrument
// design, 2026-10-17): the headline, the lifecycle words and filters,
// the search, and the on-screen email mask. Everything is counted from
// the contacts the API returns; nothing is estimated.
//
// L-3c (TASKS-LANGUAGES.md): the words are the "customers" catalogue
// through an optional translator, English by default from messages/en.json,
// so English says exactly what it always said. Names and addresses are
// content, shown as they are.

import type { Tr } from "../../lib/i18n/tr";
import { englishTr } from "../../lib/i18n/tr";

const EN = (): Tr => englishTr("customers");

export type Lifecycle = "new" | "active" | "lapsing" | "lapsed" | "unknown";

export interface ContactLite {
  name: string | null;
  email: string | null;
  lifecycle: Lifecycle;
}

/** The owner's word for each lifecycle state, and the tone that tints it. */
export const LIFECYCLE_WORD: Record<Lifecycle, { word: string; tone: "ok" | "drift" | "low" }> = {
  active: { word: "active", tone: "ok" },
  new: { word: "new", tone: "low" },
  lapsing: { word: "lapsing", tone: "drift" },
  lapsed: { word: "gone quiet", tone: "drift" },
  unknown: { word: "no history", tone: "low" },
};

/** Filter order on screen. */
export const LIFECYCLE_ORDER: readonly Lifecycle[] = [
  "active",
  "new",
  "lapsing",
  "lapsed",
  "unknown",
];

/** The lifecycle word in the reader's language (English: LIFECYCLE_WORD's). */
export function lifecycleWord(l: Lifecycle, tr: Tr = EN()): string {
  return tr(`lifecycle.${l}`);
}

/** "3,884 customers. 412 have gone quiet." — counts grouped the reader's way. */
export function customersHeadline(total: number, lapsed: number, tr: Tr = EN()): string {
  if (total === 0) return tr("headline.none");
  const first = tr("headline.count", { total });
  // The two sentences meet the way the language joins them: Chinese puts no space after "。".
  const join = (then: string) => tr("headline.join", { first, then });
  if (lapsed === 0) return join(tr("headline.quietNone"));
  if (lapsed === total && total > 1) return join(tr("headline.quietAll"));
  return join(tr("headline.quiet", { lapsed }));
}

/**
 * The address as the screen shows it: "le•••@gmail.com". The full
 * address stays in the record — the mask only keeps it off a screen
 * someone else might be looking at.
 */
export function maskEmail(email: string | null, tr: Tr = EN()): string {
  if (!email) return tr("noEmail");
  const at = email.lastIndexOf("@");
  if (at <= 0) return "•••";
  const local = email.slice(0, at);
  const keep = local.length <= 2 ? 1 : 2;
  return `${local.slice(0, keep)}•••${email.slice(at)}`;
}

/** Name or email contains the query, case-insensitively; an empty query keeps all. */
export function matchesQuery(c: ContactLite, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === "") return true;
  return (c.name ?? "").toLowerCase().includes(q) || (c.email ?? "").toLowerCase().includes(q);
}

export function filterContacts<T extends ContactLite>(
  contacts: readonly T[],
  lifecycle: Lifecycle | "all",
  query: string,
): T[] {
  return contacts.filter(
    (c) => (lifecycle === "all" || c.lifecycle === lifecycle) && matchesQuery(c, query),
  );
}
