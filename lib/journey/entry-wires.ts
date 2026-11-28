// The free check's answers the interview can take (ux-spec §7.0): pure,
// so the route that remembers a result and the tests read no database.

import type { EntryAnswers } from "../entry/one-number";

/** The cookie the result's button leaves for an hour (app/api/entry/keep). */
export const ENTRY_COOKIE = "syb_entry";
export const ENTRY_COOKIE_SECONDS = 60 * 60;

const TOKEN = /^[A-Za-z0-9_-]{8,40}$/;

export function isEntryToken(token: string | undefined | null): token is string {
  return typeof token === "string" && TOKEN.test(token);
}

/** Pure: the interview questions the check answered, as the interview's own wire values. */
export function entryWires(a: EntryAnswers): { questionId: string; wire: string | number }[] {
  const out: { questionId: string; wire: string | number }[] = [];
  if (a.sector) out.push({ questionId: "1.2", wire: a.sector });
  if (a.country) {
    // legal.country is free text the owner types; its English name reads back
    // through lib/core/country like any other answer.
    const name = new Intl.DisplayNames(["en"], { type: "region" }).of(a.country) ?? a.country;
    out.push({ questionId: "1.1b", wire: name });
  }
  if (Number.isInteger(a.employees) && a.employees >= 1) {
    out.push({ questionId: "1.6", wire: a.employees });
  }
  return out;
}
