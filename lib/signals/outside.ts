// Outside signals: reading them for one business (./view says what a screen
// is handed, ./holidays where the days come from).
//
// The only thing read is the business's own country, from its fact sheet: an
// answered fact, as a code. "I don't know", a skipped question and one never
// asked are all "no country", and then no calendar is assumed (rule 5).
// Everything after that is arithmetic. No request leaves, no model is
// called, and nothing is written.

import { countryCode } from "../core/country";
import { enumCode } from "../core/enum-value";
import { readCurrentField } from "../profile/field-store";
import type { OutsideView } from "./view";
import { outsideView } from "./view";

export const COUNTRY_FIELD = "legal.country";

/** The business's country as an ISO code, or null when the fact sheet does not hold one. */
export async function businessCountry(profileId: string): Promise<string | null> {
  const field = await readCurrentField<unknown>(profileId, COUNTRY_FIELD);
  if (!field || (field.status !== "answered" && field.status !== "inferred")) return null;
  const raw = enumCode(field.value) ?? (typeof field.value === "string" ? field.value : null);
  return raw === null ? null : countryCode(raw);
}

/** The outside signals for one business over `days` days from `from` (that day included). */
export async function loadOutside(
  profileId: string,
  from: string,
  days: number,
): Promise<OutsideView> {
  return outsideView(await businessCountry(profileId), from, days);
}
